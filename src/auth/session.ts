import { CookieJar } from "tough-cookie";
import { z } from "zod";
import { AccodingClient, ApiError } from "../accoding/client";
import { currentUser, login } from "../accoding/adapters";
import { hash } from "../model";

const credentialsSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type Credentials = z.infer<typeof credentialsSchema>;
type User = Awaited<ReturnType<typeof currentUser>>;
interface Secrets {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}
const sessionKey = "accoding.session";
const credentialsKey = "accoding.credentials";

/** Uses VS Code SecretStorage only. No passwords in workspace/settings/logs. */
export class AccountSession {
  client = new AccodingClient();
  user?: User;
  private generation = 0;
  private pending?: Promise<User | undefined>;
  private writes: Promise<void> = Promise.resolve();
  private rejectedCredentials?: string;
  constructor(
    private secrets: Secrets,
    private changed: () => void = () => {},
    private backend = { login, currentUser },
  ) {}
  private assertCurrent(generation: number) {
    if (generation !== this.generation) throw Error("登录操作已取消。");
  }
  private write(action: () => Promise<void>) {
    const pending = this.writes.then(action);
    this.writes = pending.catch(() => {});
    return pending;
  }
  private async accept(
    candidate: Awaited<ReturnType<typeof login>>,
    generation: number,
    credentials?: Credentials,
    remember?: boolean,
  ) {
    const serialized = JSON.stringify(await candidate.client.jar.serialize());
    this.assertCurrent(generation);
    try {
      await this.write(async () => {
        this.assertCurrent(generation);
        if (remember === true)
          await this.secrets.store(credentialsKey, JSON.stringify(credentials));
        else if (remember === false) await this.secrets.delete(credentialsKey);
        await this.secrets.store(sessionKey, serialized);
      });
      this.assertCurrent(generation);
    } catch {
      candidate.client.cancel();
      this.assertCurrent(generation);
      throw Error("无法安全保存登录信息，请检查 VS Code 的系统凭据存储。");
    }
    this.client.cancel();
    this.changed();
    this.client = candidate.client;
    this.user = candidate.user;
    return candidate.user;
  }
  async signIn(credentials: Credentials, remember: boolean) {
    credentials = credentialsSchema.parse(credentials);
    const generation = ++this.generation;
    this.pending = undefined;
    const candidate = await this.backend.login(
      credentials.username,
      credentials.password,
    );
    this.assertCurrent(generation);
    const user = await this.accept(
      candidate,
      generation,
      credentials,
      remember,
    );
    this.rejectedCredentials = undefined;
    return user;
  }
  private async recover(generation: number): Promise<User | undefined> {
    await this.writes;
    this.assertCurrent(generation);
    const raw = await this.secrets.get(credentialsKey);
    this.assertCurrent(generation);
    if (!raw || hash(raw) === this.rejectedCredentials) return;
    let credentials: Credentials;
    try {
      credentials = credentialsSchema.parse(JSON.parse(raw));
    } catch {
      await this.write(async () => {
        this.assertCurrent(generation);
        await this.secrets.delete(credentialsKey);
      });
      return;
    }
    let candidate: Awaited<ReturnType<typeof login>>;
    try {
      candidate = await this.backend.login(
        credentials.username,
        credentials.password,
      );
    } catch (e) {
      this.assertCurrent(generation);
      if (e instanceof ApiError && e.kind === "auth") {
        // A rejected password is tried once per extension session; ask for a new one.
        this.rejectedCredentials = hash(raw);
        return;
      }
      throw Error(
        "自动登录暂时失败，请检查网络后重试；已保存的账号密码仍保留。",
      );
    }
    this.assertCurrent(generation);
    return this.accept(candidate, generation);
  }
  private singleFlight(
    action: (generation: number) => Promise<User | undefined>,
  ) {
    if (this.pending) return this.pending;
    const pending = action(this.generation).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }
  ensure() {
    return this.singleFlight(async (generation) => {
      try {
        const user = await this.backend.currentUser(this.client);
        this.assertCurrent(generation);
        const serialized = JSON.stringify(await this.client.jar.serialize());
        await this.write(async () => {
          this.assertCurrent(generation);
          await this.secrets.store(sessionKey, serialized);
        });
        this.assertCurrent(generation);
        this.user = user;
        return user;
      } catch (e) {
        this.assertCurrent(generation);
        if (!(e instanceof ApiError) || e.kind !== "auth") throw e;
        this.user = undefined;
        await this.write(async () => {
          this.assertCurrent(generation);
          await this.secrets.delete(sessionKey);
        });
        return this.recover(generation);
      }
    });
  }
  restore() {
    return this.singleFlight(async (generation) => {
      await this.writes;
      this.assertCurrent(generation);
      const serialized = await this.secrets.get(sessionKey);
      this.assertCurrent(generation);
      if (serialized) {
        let jar: CookieJar | undefined;
        try {
          jar = await CookieJar.deserialize(serialized);
        } catch {
          // A damaged cookie does not invalidate separately saved credentials.
        }
        this.assertCurrent(generation);
        if (jar) {
          const candidate = new AccodingClient(jar);
          try {
            const user = await this.backend.currentUser(candidate, {
              retries: 0,
              timeoutMs: 10000,
            });
            this.assertCurrent(generation);
            return await this.accept({ client: candidate, user }, generation);
          } catch (e) {
            this.assertCurrent(generation);
            if (!(e instanceof ApiError) || e.kind !== "auth") {
              // Keep a restored cookie available when startup is temporarily offline.
              this.client = candidate;
              throw e;
            }
          }
        }
        await this.write(async () => {
          this.assertCurrent(generation);
          await this.secrets.delete(sessionKey);
        });
      }
      return this.recover(generation);
    });
  }
  dispose() {
    ++this.generation;
    this.pending = undefined;
    this.client.cancel();
  }
  async logout() {
    ++this.generation;
    this.pending = undefined;
    this.client.cancel();
    this.changed();
    this.client = new AccodingClient();
    this.user = undefined;
    this.rejectedCredentials = undefined;
    await this.write(async () => {
      await this.secrets.delete(sessionKey);
      await this.secrets.delete(credentialsKey);
    });
  }
}
