# 本地编译与调试环境

开发候选 0.1.0。已验证 macOS arm64 上 Clang 的 C/C++ 编译和本地评测；Windows/Linux 的 CI 编译和 Judge 已通过；交互调试仍需验收。

## macOS

安装 Apple Command Line Tools，终端检查 `clang --version`、`clang++ --version`。设置 `betterAccoding.compiler.c` 为 `clang`，`compiler.cpp` 为 `clang++`。Debug 使用可选扩展 CodeLLDB（vadimcn.vscode-lldb），已实测中文/空格工作区路径、所选用例 stdin、源码断点、变量检查和继续输出。首次 Debug 不会修改 launch.json。

## Windows x64

准备 MinGW-w64 GCC/G++ 和 GDB，分别检查版本。将编译器绝对路径填入设置（路径和参数分开，不加 shell 引号）。Debug 使用 Microsoft C/C++，GDB stdin 和空格路径配置仍在验收；不要把 `< input.in` 当作程序参数。

## Linux x64

安装 GCC/G++/GDB，检查 `gcc --version`、`g++ --version`、`gdb --version`。Debug 使用 Microsoft C/C++。

## 配置与限制

命令面板运行“Accoding: 检查编译环境”会实际编译并运行最小 C/C++ 程序。编译与运行的工作目录均为源文件目录，支持相对头文件和参数路径；源码快照与产物位于每次运行的独立构建目录。默认本地 C99/C++17 与 OJ 的语言菜单分别管理，不代表 OJ 使用同一标准。

本地运行受 Workspace Trust 限制。用户程序拥有当前系统用户权限；本工具不是安全沙箱，不模拟 OJ 的内存或 CPU 环境。Remote SSH、WSL、容器和虚拟工作区不在 0.1.0 的验收范围。
