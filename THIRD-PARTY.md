Third-Party Notices / 第三方素材署名
=====================================

NEON STRIKE（霓虹突袭）本体代码采用 MIT 许可（见 LICENSE）。
但游戏里用到的**第三方模型与库各有自己的许可**，必须分别遵守，列表如下。

──────────────────────────────────────────────────────────────
1. 地图模型（全部来自 Sketchfab，许可均为 CC-BY-4.0）
──────────────────────────────────────────────────────────────
CC-BY-4.0 要求：**署名作者 + 标明许可 + 注明是否修改**。本项目的处理方式：
模型经本项目的工具做了**格式转换与视觉调整**（转为 .glb、统一尺寸、按材质做静态合并、
开启 flatShading 平涂着色），属于"修改"，故在此一并声明。

| 文件 | 原作名 | 作者 | 许可 |
|---|---|---|---|
| map-stylized_little_japanese_town_street.glb | Stylized Little Japanese Town Street | Michał Solarek (@misiek13) | CC-BY-4.0 |
| map-japanese_temple.glb | Japanese Temple | Jainesh Pathak (@spectraut2) | CC-BY-4.0 |
| map-japanese_torii_gate_game_asset.glb | Japanese Torii gate Game Asset | Bazylonator | CC-BY-4.0 |
| map-japanese_traffic_assets.glb | Japanese Traffic Assets | Erik Kinč (@erikkinc) | CC-BY-4.0 |
| map-anime_stylized_room_free.glb | Anime stylized room free | CG Lads (@CGlads) | CC-BY-4.0 |
| map-shoji_screen.glb | Shoji Screen | Geraldo Pratama Wahyu Teddy (@juyo) | CC-BY-4.0 |
| map-grey_japanease_apartment.glb | Grey Japanease Apartment | Kasuga𓅂 (@kasuga) | CC-BY-4.0 |
| map-sakura_tree_01_-_low_poly_model.glb | Sakura Tree 01 - Low Poly Model | Jogoss (@thejogoss9) | CC-BY-4.0 |

许可全文：https://creativecommons.org/licenses/by/4.0/

> 注：`map-japanese_torii_gate_game_asset.glb` 目前在玩家版与开发版里都**没有被加载**
> （不在 `world.js` 的 `MODEL_MAP` 中），保留在源码目录里仅作为可选素材。若将来不使用，
> 可以从仓库中移除，署名也就不再需要。

──────────────────────────────────────────────────────────────
2. 武器模型
──────────────────────────────────────────────────────────────
`qbz191.glb`（游戏内显示名 QBZ-191）
- 来源：由本项目作者提供的 `.3mf` 模型，经本项目的 `tools/tenglong.mjs` 自动提取零件、
  减面并导出为 .glb（属于修改）。
- 原作者与许可：以随模型提供的说明为准，详见开发版 `web/models/CREDITS.txt`。
- ⚠ **发布前请自行确认该模型的授权允许再分发**；若不确定，可把该文件从仓库中移除，
  游戏会自动退回程序化枪模（`player.js` 里的内置模型），不影响可玩性。

`QBZ191-alt.glb`
- QBZ-191 by GoldbergR（via Get3DModels / Sketchfab），CC-BY-4.0。
- **玩家版未包含**；仅存在于开发版目录，未参与加载。

──────────────────────────────────────────────────────────────
3. 运行库
──────────────────────────────────────────────────────────────
| 组件 | 版本 | 许可 | 说明 |
|---|---|---|---|
| three.js | r150（UMD 构建，`web/vendor/three.min.js`） | MIT | https://threejs.org |
| GLTFLoader（three.js examples） | r150（`web/vendor/GLTFLoader.js`） | MIT | 同属 three.js 项目 |
| Tauri | 2.x（`src-tauri/`） | MIT / Apache-2.0 双许可 | https://tauri.app |
| WebView2Loader.dll | 随 WebView2 运行时 | Microsoft 许可 | Microsoft Edge WebView2 |

──────────────────────────────────────────────────────────────
4. 其它
──────────────────────────────────────────────────────────────
- 全部贴图（`web/textures/`）由本项目的 canvas 程序化生成或作者自备，不含第三方素材。
- 音效（`web/src/audio.js`）由 WebAudio 程序化合成，不含第三方音频素材。
