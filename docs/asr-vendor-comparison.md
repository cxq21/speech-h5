# 实时语音识别（流式中文 ASR）引擎选型调研

> 调研时间：2026-10-27。数据来自各家官方文档和定价页，均在本次调研中实际打开核对。查不到的项写「未查到」。价格以控制台实际出账为准。
> **首要评分维度（用户已确认）：方言覆盖广度，以及是否用一个模型自动识别方言（不需要手动切换）。** 第一版必须覆盖：粤语、四川话、上海话、闽南语、东北话/河南话等北方方言。

---

## 0. 结论速览

| 排名 | 方案 | 方言覆盖广度 | 单模型自动识别方言 | 浏览器接入方式 | 价格（官方） |
|---|---|---|---|---|---|
| **1（首选）** | **讯飞 实时语音转写大模型**（`lang=autodialect`） | **中英 + 202 种方言**，基本覆盖全国地级市；必选的 6 类全部支持 | ✅ 一个模型免切换 | 签名放在 URL 里，后端签好后浏览器可直连（也可以走中转） | 只有预付费时长包：¥198/40h 到 ¥600000/30万h（约 4.95→2.0 元/h）；免费 5h（个人）/50h（企业） |
| **2（备选）** | **阿里云百炼 Fun-ASR-Realtime**（`fun-asr-realtime`） | 粤、吴、闽南、客家、赣、湘、晋 7 大方言，加中原/西南/冀鲁/江淮/兰银/胶辽/东北/北京/港台等官话口音（含河南、四川、重庆、天津、山东等地）；必选 6 类全部支持 | ✅ 一个模型，`language_hints` 不填时自动识别 | 鉴权走 `Authorization` 头，**必须后端中转** | 0.00033 元/秒（约 1.19 元/h），RPM 1200 |
| 3（第二备选/性价比） | **腾讯云 16k_zh_en_2.0**（大模型2.0，实时 V2 接口） | 中英粤 + 31 种方言（按城市列出，含上海、四川、闽南、黑龙江/吉林/辽宁、郑州等）；必选 6 类全部支持 | ✅ 一个引擎 | 签名 URL 带过期时间，后端签好后浏览器可直连 | 大模型2.0 后付费 1.0 元/h；V2 接口默认 50 并发 |
| 4 | 火山引擎 豆包流式语音识别 2.0 | 文档列出：中英、上海话、闽南语、四川、陕西、粤语、冀鲁、兰银、江淮；**东北官话只能检测语种标签、不出识别结果**，河南话没有单独写明 | ✅ 默认模型（不传 language） | 鉴权走 HTTP Header，**必须后端中转** | 后付费 1 元/h（见 §6 来源说明），免费 20h |
| 5 | 百度智能云 实时语音识别 | 多方言模型 15376 只支持：普通话、粤语、四川话、东北话 | ✅（只限这 4 种） | 握手帧里要传 API Key，**建议后端中转** | 3 元/h，免费 10h |
| — | 阿里云智能语音交互（NLS，传统实时识别） | 方言很多（粤/四川/上海/闽南/东北/河南等 20 多种），但**一种方言对应一个项目模型** | ❌ 要按项目/Appkey 切换，不能用请求参数切换 | Token 放在 URL 里，浏览器可直连 | 3.5 元/h 起（阶梯价） |

**推荐：首选讯飞实时语音转写大模型，备选阿里云 Fun-ASR-Realtime，腾讯云 16k_zh_en_2.0 作为第二备选和价格兜底。** 理由见 §7。

---

## 1. 方言完整清单（首要维度）

### 1.1 讯飞 实时语音转写大模型：`lang=autodialect`，中英 + 202 种方言免切换
来源：<https://www.xfyun.cn/doc/spark/asr_llm/rtasr_llm.html>（第 4 章语种列表）、<https://www.xfyun.cn/services/rtasr_llm>

完整清单（原文照录）：
合肥话、芜湖话、皖北话、铜陵话、安庆话、黄山话、滁州话、六安话、池州话、宣城话、粤语、北京话、福州话、闽南语、莆仙话、延平话、宁德话、永安话、兰州话、白银话、天水话、武威话、张掖话、平凉话、酒泉话、庆阳话、定西话、韶关话、潮汕话、客家话、桂南平话、柳州话、桂北平话、桂林话、来宾话、贵阳话、六盘水话、遵义话、安顺话、毕节话、铜仁话、海口话、海南话、儋州话、石家庄话、唐山话、秦皇岛话、邯郸话、邢台话、保定话、张家口话、承德话、沧州话、廊坊话、衡水话、太原话、郑州话、开封话、洛阳话、平顶山话、安阳话、鹤壁话、新乡话、焦作话、濮阳话、许昌话、漯河话、三门峡话、南阳话、商丘话、信阳话、周口话、驻马店话、东北话、武汉话、黄石话、十堰话、宜昌话、襄阳话、鄂州话、荆门话、孝感话、荆州话、黄冈话、咸宁话、随州话、长沙话、湘潭话、衡阳话、邵阳话、岳阳话、常德话、张家界话、益阳话、郴州话、永州话、怀化话、娄底话、延吉话、南京话、无锡话、徐州话、常州话、苏州话、南通话、连云港话、淮安话、盐城话、扬州话、镇江话、泰州话、宿迁话、靖江话、启海话、南昌话、景德镇话、萍乡话、九江话、新余话、鹰潭话、赣州话、吉安话、宜春话、抚州话、上饶话、大连话、丹东话、营口话、朝阳话、晋语、包头话、赤峰话、鄂尔多斯话、银川话、石嘴山话、吴忠话、固原话、中卫话、西宁话、海东话、济南话、青岛话、淄博话、枣庄话、东营话、烟台话、潍坊话、济宁话、泰安话、威海话、日照话、临沂话、德州话、聊城话、滨州话、菏泽话、莱芜话、大同话、阳泉话、长治话、晋城话、朔州话、晋中话、运城话、忻州话、临汾话、吕梁话、汾阳话、西安话、铜川话、宝鸡话、咸阳话、渭南话、延安话、汉中话、榆林话、安康话、商洛话、上海话、四川话、台湾话、天津话、乌鲁木齐话、吐鲁番话、哈密话、云南话、曲靖话、玉溪话、保山话、昭通话、杭州话、宁波话、温州话、嘉兴话、湖州话、绍兴话、金华话、衢州话、舟山话、台州话、丽水话、重庆话。
- 另有 `lang=autominor`：37 个语种免切换，需要提工单申请。
- 必选 6 类：粤语✅ 四川话✅ 上海话✅ 闽南语✅ 东北话✅ 河南话✅（郑州、开封、洛阳等 17 个地市）。

### 1.2 阿里云百炼 Fun-ASR-Realtime（`fun-asr-realtime`）：单模型
来源：<https://help.aliyun.com/zh/model-studio/asr-model>、<https://help.aliyun.com/zh/model-studio/fun-asr-realtime>
- 中文：普通话、粤语、吴语、闽南语、客家话、赣语、湘语、晋语。另支持中原、西南、冀鲁、江淮、兰银、胶辽、东北、北京、港台等官话，包括河南、陕西、湖北、四川、重庆、云南、贵州、广东、广西、河北、天津、山东、安徽、南京、江苏、杭州、甘肃、宁夏等地区官话口音。另有 30 种外语。
- `language_hints` 不设置时由模型自动识别语种。
- 必选 6 类：粤✅ 四川✅（西南官话）上海✅（吴语）闽南✅ 东北✅ 河南✅。
- 同平台旧模型 `paraformer-realtime-v2`：普通话、粤语、吴语、闽南语、东北话、甘肃话、贵州话、河南话、湖北话、湖南话、宁夏话、山西话、陕西话、山东话、四川话、天津话、江西话、云南话、上海话。官方建议迁移到 Fun-ASR。

### 1.3 腾讯云
来源：<https://cloud.tencent.com/document/api/1093/131127>（V2）、<https://cloud.tencent.com/document/product/1093/48982>
- **16k_zh_en_2.0**（大模型2.0，V2 接口；另有带说话人分离的 16k_zh_en_speaker_2.0）："中英粤 + 30 种方言"。V2 接口页列出的语言为：中文、英语、粤语、上海话、四川话、武汉话、贵阳话、昆明话、西安话、郑州话、太原话、兰州话、银川话、西宁话、南京话、合肥话、南昌话、长沙话、苏州话、杭州话、济南话、天津话、石家庄话、黑龙江话、吉林话、辽宁话、闽南语、客家话、南宁话、潮汕话、宁波话、无锡话、吴语。
- 16k_zh_en（大模型1.0）：同样是"31 种方言"。8k_zh_large：电话场景，28 种方言。
- Hy-ASR-3.0-preview：中英 + 20 种方言（粤语、东北话、河南话、陕西话、成都话等）。**目前是 Preview，只支持 5 分钟以内语音，且只支持 16k PCM**，不适合长时转写。
- 必选 6 类：粤✅ 四川✅ 上海✅ 闽南✅ 东北✅（黑龙江/吉林/辽宁话）河南✅（郑州话）。

### 1.4 火山引擎 豆包流式语音识别
来源：<https://www.volcengine.com/docs/6561/1354869>
- 不传 `language` 时，默认模型支持：中英文、上海话、闽南语、四川、陕西、粤语、冀鲁、兰银、江淮。
- `enable_lid` 能**识别并出结果**的：中英文、上海话、闽南语、四川、陕西、粤语。湘语、晋语、客家、潮汕、东北官话、胶辽官话等**只能检测语种标签，不出识别结果**。
- 注意：文档写明 `language` 参数只有 nostream 模式支持；`enable_lid` 只有 nostream 和双向流式优化版支持。
- 必选 6 类：粤✅ 四川✅ 上海✅ 闽南✅ **东北❌（文档明确只做检测）** 河南：未查到明确说明（中原官话标签写的是"含陕西话"）。

### 1.5 百度智能云
来源：<https://cloud.baidu.com/doc/SPEECH/s/jlbxejt2i>
- 实时识别 dev_pid=15376「中文多方言」：**只支持普通话、粤语、四川话、东北话**，标点较弱（只有逗号和句号）。
- 必选 6 类：上海❌ 闽南❌ 河南❌。

### 1.6 阿里云智能语音交互 NLS（传统实时识别）
来源：<https://help.aliyun.com/zh/isi/user-guide/api-reference>
- 方言模型：粤语（16k/8k，含繁体）、四川话、湖北话、上海话、湖南话、河南话、浙江话、东北话、山东话、天津话、陕西话、山西话、贵州话、云南话、甘肃话、苏州话、闽南语、江西话、宁夏话、广西话；另有维吾尔语。
- **语种和方言模型在项目里配置，不能用请求参数切换**：每种方言要单独建项目、用不同 Appkey，**不能自动识别方言**。

---

## 2. 流式接口与鉴权（能否浏览器直连）

| 厂商 | 接口 | 鉴权方式 | 浏览器直连？ |
|---|---|---|---|
| 讯飞 实时转写大模型 | `wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1?{参数}` | URL 参数：appId、accessKeyId、utc、signature（用 APISecret 做 HMAC 签名） | **可以**：后端签好 URL 交给前端，APISecret 不下发。文档有"签名重复"错误码（uuid 和时间相同会触发），每次都要用新的 uuid/utc 重签 |
| 阿里云 Fun-ASR-Realtime | `wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference` | 握手头 `Authorization: Bearer <API Key>` | **不可以**：浏览器原生 WebSocket 设不了自定义请求头。浏览器能否使用临时 Token：**未查到**官方说明。百炼的 AOQ 协议可以下发客户端 Token，但官方示例只有 iOS/Android/OHOS SDK |
| 阿里云 NLS | `wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1?token=` | 临时 Token（服务端用 AccessKey 调 CreateToken，带 ExpireTime） | **可以**（Token 放在 URL 里）。官方提供前端 demo.html |
| 腾讯云 | `wss://asr.cloud.tencent.com/asr/v2/<appid>?{参数}&signature=` | URL 签名（HMAC-SHA1），带 `expired`（不超过 90 天） | **可以**：后端签名。官方 JS SDK 支持临时密钥（token）和 `signCallback`。建议用短有效期加 STS 临时密钥，避免长期 SecretId 外露 |
| 火山引擎 | `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`（推荐，双向流式优化版）/ `bigmodel` / `bigmodel_nostream` | HTTP Header：X-Api-Key（新版控制台）或 X-Api-App-Key + X-Api-Access-Key，加 X-Api-Resource-Id | **不可以**：要设请求头，必须后端中转。是否支持 URL 参数鉴权：**未查到** |
| 百度 | `wss://vop.baidu.com/realtime_asr?sn=` | 第一帧 START 的 JSON 里带 appid + appkey | 技术上能直连，但会**暴露 API Key**；临时 token：**未查到**。建议后端中转 |

## 3. 音频格式

| 厂商 | 采样率 | 格式 | 发包建议 |
|---|---|---|---|
| 讯飞 大模型 | 16k（PCM 时可用 8k） | pcm_s16le / speex-7、speex-10 / **opus-wb（官方推荐）** | 每 40ms 发 1280 字节；超过 15s 不发音频会断开（第三方教程说法，官方错误码 37005 为"客户端长时间未传音频"） |
| 阿里 Fun-ASR | 任意（8k 模型只支持 8k） | pcm / wav / mp3 / opus（Ogg 封装）/ speex / aac / amr，单声道 | — |
| 阿里 NLS | 8k / 16k，要和项目模型一致 | PCM、WAV、OGG-OPUS、OGG-SPEEX、AMR、MP3、AAC，16bit 单声道 | 16k 每 100ms 3200 字节 |
| 腾讯 | 16k / 8k，16bit 单声道（Hy-ASR-3.0-preview 只支持 16k PCM） | pcm、wav、opus（自定义帧封装）、speex、silk、mp3、m4a、aac | V1：每 200ms 发 6400 字节；V2：每 40ms 发 1280 字节；不能超过 1:1 实时率；间隔超过 6s 报错 |
| 火山 | **只支持 16000**，16bit | pcm / wav / ogg(opus) / mp3 | 每包 100~200ms，双向流式建议 200ms |
| 百度 | **固定 16000**，只支持 pcm | pcm | 每帧 160ms（5120 字节）；超过 5s 不发数据会断开 |

## 4. 中间结果和首字延迟（官方说法）

| 厂商 | 中间结果 | 官方延迟说法 |
|---|---|---|
| 讯飞 | 支持（流式文字流） | 产品页写"毫秒级识别音频流"；**具体首字延迟数字：未查到** |
| 阿里 Fun-ASR | result-generated 事件持续返回 | 模型描述为"低延迟"；SDK 提供 `get_first_package_delay()` 自行测量；**具体数字：未查到** |
| 阿里 NLS | `enable_intermediate_result` | 开启语义断句"会小幅增加延迟"；**具体数字：未查到** |
| 腾讯 | slice_type=1 返回非稳态结果，词级 stable_flag | 产品页写"毫秒级"（据搜索摘要）；**具体数字：未查到** |
| 火山 | 双向流式逐字返回；`enable_nonstream` 二遍识别（先快后准） | nostream 模式"平均音频时长 5s 时可在 300~400ms 内返回"；bigmodel_async"首字、尾字时延均有一定程度提升"；有 `enable_accelerate_text` 首字加速（会降低首字准确率） |
| 百度 | MID_TEXT / FIN_TEXT | **未查到** |

> 首字延迟没有一家给出可直接对比的官方数字，**必须用自己的方言测试集实测**（见 §8）。

## 5. 标点、热词、自学习（关系到后续知识库润色）

| 厂商 | 标点 | 热词 | 自学习/定制模型 | 上下文增强 |
|---|---|---|---|---|
| 讯飞 大模型 | 默认返回，可用 punc=0 关闭 | 在控制台上传"个性化热词"（错误码显示热词必须是中文，有长度和数量限制） | 领域参数 `pd`（医疗、金融、教育等 16 个领域）；自学习：未查到 | 未查到 |
| 阿里 Fun-ASR | 支持（ITN、标点、语气词过滤） | `vocabulary_id` 预编译热词（RAG 方式支持大规模热词） | 未查到（模型调优：不支持） | ✅ `input.context`（最近 5 轮，每轮 ≤400 字），**可以直接接知识库** |
| 阿里 NLS | `enable_punctuation_prediction` | `vocabulary_id` | ✅ `customization_id` 自学习模型 | — |
| 腾讯 | 默认带标点（可过滤句末句号） | `hotword_id` 热词表；`hotword_list` 临时热词最多 128 个，权重 1-11/100（同音替换） | ✅ `customization_id`；另有 `replace_text_id` 强制替换 | — |
| 火山 | `enable_punc`（默认 true），`enable_ddc` 顺滑 | 热词表 `boosting_table_id`；`context.hotwords` 直传（双向流式 100 tokens） | 替换词表 `correct_table_id` | ✅ 对话上下文（800 tokens / 20 轮），2.0 支持传图片 |
| 百度 | 15372 加强标点；15376 多方言只有弱标点 | 未查到实时接口的热词参数 | ✅ `lm_id` 自训练平台，**只限普通话 1537/15372**，多方言模型不能用 | — |

## 6. 价格、免费额度、并发

| 厂商 | 后付费 | 预付费包 | 免费额度 | 并发 |
|---|---|---|---|---|
| 讯飞 实时转写大模型 | **未查到**（产品页只列时长套餐） | 40h ¥198（10 并发）；1000h ¥4000（30 并发）；5000h ¥17500（50）；2万h ¥60000（80）；10万h ¥240000（100）；30万h ¥600000（100），有效期 1 年 | 个人 5h/2 并发；企业 50h/5 并发，有效期 1 年 | 跟随套餐（上面括号里的数字） |
| 阿里 Fun-ASR-Realtime | 0.00033 元/秒（约 1.19 元/h，北京地域原价） | 未查到 | **未查到** | RPM 1200 |
| 阿里 NLS 实时识别 | 3.50 元/h（每日 0-299h），300-999h 3.00，1000-2999h 2.40，3000-4999h 1.60，≥5000h 1.20（日结） | 30h ¥100；1000h ¥1800；1万h ¥15000；8.4万h ¥10万；18.2万h ¥20万；30万h ¥30万 | 新用户试用 3 个月（2 路并发） | 商用版 200 路；超出部分 100 元/路/月 |
| 腾讯 大模型2.0 实时 | **1.0 元/h**（日结，无阶梯） | 60h ¥60；1000h ¥950；1万h ¥9000；10万h ¥88000；30万h ¥255000 | 大模型版**没有**免费额度（只有标准版实时识别每月 5h） | V2 接口默认 50 路；大模型2.0 并发叠加包 200 元/并发/月（上限 50） |
| 腾讯 大模型1.0 / 标准版 | 1.0 版 4.80 元/h 起阶梯；标准版 3.20 元/h 起 | 1.0：60h ¥270 起；标准：30h ¥90 起 | 标准版每月 5h | V1 接口默认 200 路 |
| 火山 豆包流式 2.0 | 1 元/h（小时版） | 1000h ¥900；1万h ¥8800；10万h ¥85000；30万h ¥240000 | 20h，有效期半年（官方计费文档） | 默认 50 并发，超出 100 元/并发/月；也有纯并发版 500 元/并发/月 |
| 百度 实时识别 | 3 元/h（普通话/英语，适用于手机近场） | 1000h ¥1800；1万h ¥15000；10万h ¥120000；50万h ¥450000 | 10h（个人 3 并发 / 企业 5 并发） | 50 并发；扩容 100 元/并发/月或 1000 元/年。多方言 15376 是否单独计价：未查到 |

> 来源说明：火山的后付费单价、资源包价格和并发价格，本次没能直接加载官方计费页正文（页面超时），数据来自**官方计费文档的 GitHub 镜像**（<https://github.com/bigmanBass666/XEngineer-dev/blob/main/docs/api/volcengine/billing.md>），请在控制台复核。免费 20h 和计费方式来自官方页 <https://docs.volcengine.com/docs/DoubaoVoice/BillingOverview-15?lang=zh>。

## 7. 推荐结论（按"方言广度 + 单模型免切换"排序）

1. **首选：讯飞 实时语音转写大模型（autodialect）**
   - 方言最全：中英 + 202 种方言，一个模型免切换，覆盖全国地级市。必选的粤、川、沪、闽南、东北、河南全部有，并且细到城市（例如河南有 17 个地市）。
   - 不限音频时长，签名 URL 方便浏览器直连，支持 opus-wb 省带宽，有热词和领域参数 `pd`。
   - 不足：贵（约 2.0~4.95 元/h，只有预付费套餐，后付费未查到）；并发和套餐绑定（例如 1000h 档只有 30 路）；热词只能在控制台配置；没看到上下文增强接口。
2. **备选：阿里云百炼 Fun-ASR-Realtime**
   - 单模型自动识别，覆盖 7 大方言区加大量官话口音，必选 6 类全部有；价格约 1.19 元/h，是同档里最便宜的。
   - 有热词，**还有上下文增强（context）**，和后续知识库润色最契合。
   - 不足：要用 Bearer 头鉴权，必须后端中转；免费额度和首字延迟未查到；方言是按"方言区/口音"写的，不像讯飞那样列到城市，**需要实测上海话、闽南语的准确率**。
3. **第二备选/价格兜底：腾讯云 16k_zh_en_2.0**：31 种方言按城市写得很清楚，必选全覆盖；1 元/h；签名 URL 能直连；有热词、自学习和替换词。但默认 50 并发，且大模型版没有免费额度。
4. 火山 2.0：价格、上下文能力和首字加速都好，但**东北官话只做检测、不出识别结果**，河南话没写明，不满足第一版的方言要求。
5. 百度：只有 4 种方言，不满足要求。阿里 NLS：方言多但要按项目切换，不满足"免切换"。

**落地建议**：ASR 适配层做成可插拔的。第一版用讯飞（方言最全）；同时接入 Fun-ASR 做 A/B 测试和降级（成本低，有 context 可接知识库）。用 §8 的方言测试集跑完后再定主引擎。

> **浏览器 Web Speech API 为什么不作首选**（经验判断，本次未专门查证）：Chrome 的实现要把音频发到 Google 服务端，在中国大陆基本不可用；各浏览器支持差异大（iOS Safari 和国内浏览器行为不一致）；无法指定方言模型，也没有热词、自学习、上下文；拿不到稳定的中间结果和计费、并发控制。只适合做 demo。

## 8. 推荐的 H5 架构

```
[浏览器 H5]
  getUserMedia({audio:{echoCancellation,noiseSuppression,channelCount:1}})
  → AudioWorklet：重采样到 16kHz、Float32 转 Int16 PCM，按 40ms（1280B）或 100~200ms 切片
  →（可选）WASM opus 编码（讯飞 opus-wb / 腾讯自定义 opus 帧）以节省上行带宽
  → WebSocket 连到【自家网关】（wss://api.xxx/asr?session=<短期 JWT>）

[后端 / 边缘函数 ASR 网关]（Node/Go；云函数要支持 WebSocket 长连接）
  - 校验用户 JWT，做限流、计时、配额和并发池管理（各家都按并发计）
  - 鉴权方式适配：
      讯飞/腾讯/阿里 NLS：服务端签 URL 或签发 Token（可改成"下发短期签名 URL 让浏览器直连"，降低网关带宽）
      Fun-ASR/火山/百度：必须由网关建上游 WS（加 Authorization / X-Api-Key 头）后双向转发
  - 统一事件协议：{type: partial|final, text, start, end, dialect?, vendor}
  - 热词和上下文注入：从知识库取领域词 → 讯飞控制台热词 / Fun-ASR context+vocabulary_id / 腾讯 hotword_list
  - 断线重连：缓存最近 N 秒音频，参考百度"断网补发"的思路按 end_time 补发
  - final 文本 → 知识库润色（LLM），异步回推前端
```

两种模式：
- **A. 网关中转（默认，所有厂商通用）**：密钥不出服务端，能统一计量和切换厂商。代价是网关要承担音频带宽（16k PCM 约 32KB/s 每路）。
- **B. 临时凭证直连（讯飞、腾讯、阿里 NLS 可用）**：后端只签发短期 URL 或 Token，浏览器直连厂商，延迟和带宽最优。但计量和防滥用要靠签名有效期和服务端配额来控制。

### 实测计划（定稿前）
- 每种方言（粤、川、沪、闽南、东北、河南，加业务重点地区）各录 20~30 条真实场景音频，统计 CER、首字延迟、尾字延迟（从最后一包到 final 结果的时间）。
- 对比"不加热词"和"加热词/上下文"两种情况；测试普通话和方言混说的句子。

## 9. 来源链接
- 讯飞 实时语音转写大模型文档：<https://www.xfyun.cn/doc/spark/asr_llm/rtasr_llm.html>
- 讯飞 产品与价格页：<https://www.xfyun.cn/services/rtasr_llm>
- 讯飞 标准版：<https://www.xfyun.cn/doc/asr/rtasr/API.html>；方言大模型（60s 短音频，按次计费）：<https://www.xfyun.cn/services/dia_model>
- 阿里 Fun-ASR 模型页（价格、RPM）：<https://help.aliyun.com/zh/model-studio/fun-asr-realtime>
- 阿里 语音识别模型总览（方言清单、音频规格）：<https://help.aliyun.com/zh/model-studio/asr-model>
- 阿里 Fun-ASR WebSocket：<https://help.aliyun.com/zh/model-studio/fun-asr-realtime-websocket-api>；客户端事件：<https://www.alibabacloud.com/help/zh/model-studio/fun-asr-client-events>
- 阿里 百炼 Realtime Token 鉴权：<https://help.aliyun.com/zh/model-studio/realtime-token-authentication>
- 阿里 NLS WebSocket 协议：<https://help.aliyun.com/zh/isi/developer-reference/websocket>；接口说明（方言模型表）：<https://help.aliyun.com/zh/isi/user-guide/api-reference>
- 阿里 NLS 计费：<https://help.aliyun.com/zh/isi/getting-started/billing-10>、<https://help.aliyun.com/zh/isi/product-overview/billing-10>；并发：<https://help.aliyun.com/zh/isi/getting-started/faq-about-concurrency-and-monitoring>；Token：<https://help.aliyun.com/zh/isi/getting-started/obtain-an-access-token>
- 腾讯 实时识别 WebSocket：<https://cloud.tencent.com/document/product/1093/48982>；V2（大模型2.0）：<https://cloud.tencent.com/document/api/1093/131127>
- 腾讯 计费：<https://cloud.tencent.com/document/product/1093/35686>；JS SDK：<https://github.com/tencentcloud/tencentcloud-speech-sdk-js>
- 火山 流式识别 API：<https://www.volcengine.com/docs/6561/1354869>；计费：<https://docs.volcengine.com/docs/DoubaoVoice/BillingOverview-15?lang=zh>；产品页：<https://www.volcengine.com/product/asr>
- 百度 实时识别 API：<https://cloud.baidu.com/doc/SPEECH/s/jlbxejt2i>；计费：<https://cloud.baidu.com/doc/SPEECH/s/Tldjm0i4c>；免费额度：<https://cloud.baidu.com/doc/SPEECH/s/Wl9mh4doe>
