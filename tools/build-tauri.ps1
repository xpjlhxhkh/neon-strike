# =====================================================================
#  霓虹突袭（玩家版）— Tauri 桌面外壳一键构建
#  本文件由开发版 tools/build-tauri.ps1 自动改造而来（见 fps-game/tools/make-player.mjs）
#  ---------------------------------------------------------------------
#  用法:  powershell -ExecutionPolicy Bypass -File tools\build-tauri.ps1
#
#  产物:  NEON STRIKE.exe（Tauri 桌面程序，前端来自 web/）+ WebView2Loader.dll
#
#  前置条件（一次性）:
#    1) Rust 的 GNU 工具链（本机已装）:
#         rustup toolchain install stable-x86_64-pc-windows-gnu --profile minimal
#         rustup component add rust-mingw --toolchain stable-x86_64-pc-windows-gnu
#    2) MinGW 工具（gcc / binutils，放在 .toolchain\mingw 下，repo 里已带）
#
#  为什么这么绕（踩过的坑，都写在这里免得下次再撞）:
#    · crates.io 官方源在本机只有 ~38 KB/s → 用 USTC 镜像（见 src-tauri\.cargo\config.toml）
#    · 本机没有 Visual Studio / MSVC 链接器 → 走 GNU 目标 + Rust 自带 rust-lld
#    · windres 需要 gcc 做预处理 → 提供 .toolchain\gcc_shim.rs 编出的垫片
#      （.rc 里没有 #include，透传即可），windres 只会找它自己同目录的 gcc
#    · rust-lld 用 --subsystem,windows 时入口点不对 → 按 console 链接后
#      直接改 PE 头的子系统字段为 2(GUI)：既没有控制台窗口，入口点也正确
#    · GNU 目标下 Tauri 动态依赖 WebView2Loader.dll → 必须随 exe 一起放
# =====================================================================
$ErrorActionPreference = 'Stop'

$root      = Split-Path -Parent $PSScriptRoot          # 游戏根目录
$srcTauri  = Join-Path $root 'src-tauri'
$toolchain = Join-Path $root '.toolchain'
# 玩家版包里不带 .toolchain（开发版构建工具，几百 MB）：先在上一级目录里找。
# 只放 ASCII 的候选路径、只报 ASCII 的错 —— 中文一多，Windows PowerShell 5.1
# 解析这个文件时会出问题（踩过，见项目 FINDINGS #1 同族坑）。
if (-not (Test-Path (Join-Path $toolchain 'mingw'))) {
    $p = Split-Path -Parent $root
    if ($p -and (Test-Path $p)) {
        foreach ($c in @((Join-Path $p '.toolchain'),
                         (Join-Path $p 'fps-game\.toolchain'))) {
            if (Test-Path (Join-Path $c 'mingw')) { $toolchain = $c; break }
        }
    }
}
if (-not (Test-Path (Join-Path $toolchain 'mingw'))) {
    throw "toolchain not found: put the dev .toolchain folder next to the player folder (or copy it in)."
}
Write-Host "toolchain: $toolchain"
$mingwBin  = Join-Path $toolchain 'mingw\mingw64\bin'
$webDir    = Join-Path $root 'web'
$outExe    = Join-Path $root 'NEON STRIKE.exe'

Write-Host "游戏目录 : $root"

# ---------------------------------------------- 非 ASCII 路径 → 换 ASCII 目录编译
# 实测：MinGW 的 dlltool 处理不了中文路径（会把路径读成乱码，报
# "Can't create .lib file: ... No such file or directory"）。所以构建前先检查，
# 需要的话把"源码 + 前端"复制到一个 ASCII 暂存目录里编译，再把 exe/DLL 拷回来。
function Test-AsciiPath([string]$p) {
    foreach ($ch in $p.ToCharArray()) { if ([int]$ch -gt 127) { return $false } }
    return $true
}
$buildRoot = $root
if (-not (Test-AsciiPath $root)) {
    $buildRoot = Join-Path $env:TEMP 'neon-player-ascii'
    Write-Host "路径含非 ASCII 字符 -> 使用 ASCII 暂存目录构建: $buildRoot"
    if (Test-Path $buildRoot) { Remove-Item $buildRoot -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
    foreach ($d in @('web', 'src-tauri', 'tools')) {
        Copy-Item (Join-Path $root $d) (Join-Path $buildRoot $d) -Recurse -Force
    }
}

# ---------------------------------------------------------------- 前置检查
if (-not (Test-Path (Join-Path $webDir 'index.html'))) { throw "找不到 web\index.html（前端目录不完整）" }
if (-not (Test-Path $mingwBin)) { throw "找不到 $mingwBin（MinGW 工具链缺失）" }

$rustupHome = Join-Path $env:USERPROFILE '.rustup'
$tcGnu = Join-Path $rustupHome 'toolchains\stable-x86_64-pc-windows-gnu'
if (-not (Test-Path $tcGnu)) {
    throw "缺少 Rust GNU 工具链，请先执行:`n  rustup toolchain install stable-x86_64-pc-windows-gnu --profile minimal`n  rustup component add rust-mingw --toolchain stable-x86_64-pc-windows-gnu"
}

# Rust 自己的目录里也要有真正的 dlltool（rust-mingw 只带一个转发壳）
$selfContained = Join-Path $tcGnu 'lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained'
$realDlltool = Join-Path $mingwBin 'dlltool.exe'
if ((Test-Path $realDlltool) -and -not (Test-Path (Join-Path $selfContained 'dlltool.exe.shim.bak'))) {
    Copy-Item (Join-Path $selfContained 'dlltool.exe') (Join-Path $selfContained 'dlltool.exe.shim.bak') -Force -ErrorAction SilentlyContinue
}
if (Test-Path $realDlltool) { Copy-Item $realDlltool (Join-Path $selfContained 'dlltool.exe') -Force }
foreach ($d in @('libintl-8.dll','libiconv-2.dll','libzstd.dll','zlib1.dll','libwinpthread-1.dll','libasprintf-0.dll')) {
    $p = Join-Path $mingwBin $d
    if (Test-Path $p) { Copy-Item $p $selfContained -Force -ErrorAction SilentlyContinue }
}

# windres 会调用"它自己同目录下的 gcc"做预处理，而本机没有可用的完整 gcc
# （rust-mingw 自带的 cc1 跑不起来）。这里部署一个垫片：.rc/.def 原样透传，
# 其它情况转交给真正的 triplet gcc（x86_64-w64-mingw32-gcc）。
$shimSrc = Join-Path $toolchain 'gcc_shim.rs'
$shimExe = Join-Path $toolchain 'ppbin\gcc.exe'
if (-not (Test-Path $shimExe)) {
    Write-Host "编译 gcc 垫片..."
    New-Item -ItemType Directory -Force -Path (Split-Path $shimExe) | Out-Null
    & (Join-Path $env:USERPROFILE '.cargo\bin\rustc.exe') -O --edition 2021 -o $shimExe $shimSrc
    if ($LASTEXITCODE -ne 0) { throw "gcc 垫片编译失败" }
}
$gccInMingw = Join-Path $mingwBin 'gcc.exe'
$gccOrig = Join-Path $mingwBin 'gcc-orig.exe'
if ((Test-Path $gccInMingw) -and -not (Test-Path $gccOrig)) {
    Copy-Item $gccInMingw $gccOrig -Force -ErrorAction SilentlyContinue
}
if ((Test-Path $shimExe) -and (Test-Path $gccInMingw) -and
    ((Get-Item $shimExe).Length -ne (Get-Item $gccInMingw).Length)) {
    Copy-Item $shimExe $gccInMingw -Force
    Write-Host "  已部署 gcc 垫片（供 windres 预处理 .rc）"
}

# ------------------------------------------------------------------- 构建
$env:PATH = (@(
    (Join-Path $env:USERPROFILE '.cargo\bin'),
    $mingwBin,
    $selfContained,
    (Join-Path $tcGnu 'lib\rustlib\x86_64-pc-windows-gnu\bin'),
    $env:PATH
) -join ';')

$srcTauri = Join-Path $buildRoot 'src-tauri'      # 非 ASCII 路径时已切到暂存目录
$webDir   = Join-Path $buildRoot 'web'
Push-Location $srcTauri
try {
    Write-Host "开始构建（首次约 1~3 分钟）..."
    & cargo build --release
    if ($LASTEXITCODE -ne 0) { throw "cargo build 失败（退出码 $LASTEXITCODE）" }
} finally { Pop-Location }

$built = Join-Path $srcTauri 'target\release\neon-strike.exe'
if (-not (Test-Path $built)) { throw "没有生成 $built" }

# --------------------------------------------- 改 PE 子系统为 GUI（无控制台）
function Set-PeGuiSubsystem([string]$path) {
    $b = [System.IO.File]::ReadAllBytes($path)
    $optOff = [BitConverter]::ToInt32($b, 0x3C) + 4 + 20   # e_lfanew + PE签名 + COFF头
    $subOff = $optOff + 68                                  # 可选头里的 Subsystem 字段
    $cur = [BitConverter]::ToUInt16($b, $subOff)
    if ($cur -eq 2) { Write-Host "  子系统已是 GUI(2)"; return }
    [BitConverter]::GetBytes([UInt16]2).CopyTo($b, $subOff)
    [System.IO.File]::WriteAllBytes($path, $b)
    Write-Host "  子系统字段 $cur → 2 (GUI)"
}
Set-PeGuiSubsystem $built

# --------------------------------------------------- 部署 exe 与运行时依赖
Copy-Item $built $outExe -Force
Write-Host "已生成 : $outExe  ($([math]::Round((Get-Item $outExe).Length/1MB,2)) MB)"

# WebView2Loader.dll（GNU 目标下是动态依赖，必须跟着 exe）
$loader = Get-ChildItem (Join-Path $env:USERPROFILE '.cargo\registry') -Recurse -Filter 'WebView2Loader.dll' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } | Select-Object -First 1
if ($loader) {
    Copy-Item $loader.FullName (Join-Path $root 'WebView2Loader.dll') -Force
    Write-Host "已附带 : WebView2Loader.dll (x64)"
} else {
    Write-Warning "没找到 x64 的 WebView2Loader.dll，程序会因缺少它而无法启动"
}

Write-Host ""
Write-Host "完成，双击 $outExe 即可运行。" -ForegroundColor Green
