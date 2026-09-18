# 霓虹突袭 · NEON STRIKE

一个用 **Three.js + Tauri** 做的桌面第一人称射击游戏。舞台是一个**玩具微缩风格的日式街区**：
红砖房、彩色集装箱码头、天桥、中央阶梯高台、樱花树林，以及一座五重塔。

> 纯前端实现，没有构建步骤（`web/` 全是 `<script>` 标签直接加载）；
> 桌面外壳用 Tauri 2，产物是一个双击即玩的 Windows exe。

**当前版本：v0.50**

---

## 玩法

| 模式 | 说明 |
|---|---|
| **开始游戏** | 竞技场，共 **8 关**。每关固定 **20 个敌人**，开局一次性全部出现，刷在离你 60~95 米的场地外圈、彼此间隔 18 米以上。清空全部敌人即过关。 |
| **训练场** | 太空站场景，**无关卡、子弹无限**，场上固定 5 个随机兵种，清空后自动再刷一轮；敌人**只会走动、不会攻击**。 |

- **索敌名额**：士兵同时最多 **6 个**能锁定你并开枪；名额满了的士兵发现你也**不射激光**，只会冲上来近身攻击。**特殊兵种不受这个限制**。
- **敌人感知**：视野 30 米 / 165°，贴到 10 米内必被发现；追丢后会去搜索你最后出现的位置，约 11 秒才放弃。一个敌人发现你，附近 45 米内的队友会一起警戒。
- **激光**：远程敌人开火前会先亮起红色瞄准线 —— **激光会穿墙**，躲掩体后面没用，得横向跑开离开瞄准线。
- **方位条**：屏幕最上方那条显示 60 米内的敌人，**中点就是你的正前方**，黄点表示正在锁定你。
- **得分**：普通敌人击杀 +100、爆头击杀 +150，每关清空额外 60 × 关数；2.5 秒内连杀还有额外奖励。

## 按键

| 按键 | 功能 |
|---|---|
| `W` `A` `S` `D` | 移动 |
| 鼠标移动 | 瞄准视角 |
| 鼠标左键 | 射击（按住连发） |
| 鼠标右键 | 开镜 / 收镜（点一下切换，移速与跳跃不受影响） |
| `R` | 换弹 |
| `F` | 检视枪械 |
| `Shift` | 冲刺（可跑跳） |
| `空格` | 跳跃 |
| `Esc` | 暂停菜单 |
| `M` | 静音开关 |
| `Alt` | **仅训练场**：呼出鼠标 → 左上角菜单（敌人全部停止 / 全部移动 / 清空 / 按兵种添加），再按一次回到游戏 |

## 怎么玩

**方式一：下载现成的 exe（推荐）**
到 [Releases](../../releases) 页面下载 `NEON STRIKE.exe` 和 `WebView2Loader.dll`，
**两个文件放同一个文件夹**，双击 exe 即可。下载后建议核对 `SHA256SUMS.txt` 里的校验值。

> Windows 10/11 一般自带 WebView2 运行时；若提示缺失，装一次
> [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) 即可。

**方式二：直接用浏览器跑**
`web/` 是纯静态站点，没有构建步骤：

```bash
# 任意静态服务器都行（必须走 http，直接双击 html 会有跨域限制）
npx serve web
# 然后浏览器打开提示的地址
```

## 自己编译（可选）

需要 Rust 的 GNU 工具链。本项目的构建脚本会把 PE 子系统改成 GUI(2)
（否则 GNU 目标下双击会秒退）：

```powershell
rustup toolchain install stable-x86_64-pc-windows-gnu --profile minimal
rustup component add rust-mingw --toolchain stable-x86_64-pc-windows-gnu
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-tauri.ps1
```

产物：`NEON STRIKE.exe` + `WebView2Loader.dll`。

> 本机构建时 `src-tauri/.cargo/config.toml` 强制走了 USTC 镜像；
> 如果你在海外，注释掉那个文件里的 `[source.crates-io]` / `[source.ustc]` 两段即可。

如果不用上面的脚本、直接 `cargo build`：**必须自己补 PE 子系统那一步**
（GUI 目标下设置成 console 子系统是为了入口点正确），否则产物双击没反应：

```powershell
$exe = 'src-tauri/target/release/neon-strike.exe'
$b = [System.IO.File]::ReadAllBytes($exe)
$subOff = [BitConverter]::ToInt32($b, 0x3C) + 4 + 20 + 68
[BitConverter]::GetBytes([UInt16]2).CopyTo($b, $subOff)
[System.IO.File]::WriteAllBytes($exe, $b)
```

自动化发版见 `.github/workflows/release.yml`（打 `v*` 标签即触发，
CI 里已经处理了镜像、工具链、PE 子系统这三件事）。

## 技术要点（给好奇的人）

- **没有构建步骤**：`web/` 全靠 `<script>` 标签，改完刷新就见效。
- **自研零依赖 BVH**（`web/src/bvh.js`）：扁平 `Float32Array` 节点、三角形级精确碰撞，
  配合 16 米空间网格做粗筛，单次碰撞解算约 **20 µs**（799 个实例）。
- **静态合并**（`web/src/merge-static.js`）：把碎网格模型按材质合并，
  公寓 135 个网格 → ≤10 个，实测 31 帧 / 1095 draw call → 83 帧 / 834 draw call。
- **后处理**（`web/src/postfx.js`）：自研管线，泛光 / 上帝光 / ACES / 分级 / 暗角 / FXAA / 抖动，
  按地图独立保存画面预设（玩具微缩 / 干净写实 / 电影感 / 夜景 / 动画平涂）。
- **加载页**：10 个资源文件串行加载，一条进度条 + 右侧百分比 + `第 N / 共 10`。
- **地图**：798 个物体的布局数据在 `web/src/layout-default.js`。

## 目录结构

```
web/                  游戏本体（纯静态，无构建步骤）
  index.html          全部 UI 结构与样式
  src/                主循环 / 地图 / 敌人 / 玩家 / 碰撞 / 后处理 / 存档
  vendor/             three.js r150 + GLTFLoader
  models/             地图模型 + 武器模型（许可见 THIRD-PARTY.md）
  textures/           程序化生成或作者自备的贴图
src-tauri/            Tauri 2 桌面外壳（Rust）
tools/                构建脚本与验收脚本
```

## 存档

存档写在**游戏目录下的 `saves/`**（跟 exe 同级），不会写到用户目录或临时目录。
换机器直接拷这个文件夹。

## 许可

- **本项目代码与美术：MIT**（见 [LICENSE](LICENSE)）
- **第三方模型与运行库各有自己的许可**，其中 8 个地图模型是 **CC-BY-4.0**，
  必须署名作者 —— 完整列表与作者见 **[THIRD-PARTY.md](THIRD-PARTY.md)**

这是个非商业项目，随便玩、随便传，但请保留上面两份文件里的署名。

## 已知问题

- **激光会穿墙**：掩体挡不住激光（这是当前实现的实际行为，不是笔误），只能靠位移躲。
- 建筑内部是"表面碰撞"，房子能走进去、里面是空的。
- 武器模型 `qbz191.glb` 的再分发授权**尚未最终确认**（见 THIRD-PARTY.md 第 2 节）；
  如果它被移除，游戏会自动退回程序化枪模，不影响可玩性。
