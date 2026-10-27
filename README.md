# speech-h5：H5 实时语音转文字（讯飞方言识别大模型 · 202 种方言免切换）

浏览器用 AudioWorklet 采集音频，转成 16kHz/16bit 单声道 PCM，每 40ms 切一帧（1280 字节），经本服务的 WebSocket 中转，送到**讯飞方言识别大模型**（`wss://iat.cn-huabei-1.xf-yun.com/v1`，`domain=slm`，`accent=mulacc`：普通话、简单英语和 202 种方言，不用手动切换）。页面上的中间结果是灰色的（`dwa=wpgs` 流式动态修正），确认后替换成正式文本。

```
浏览器 (public/) ──ws(s)://<域名>/asr──▶ Node 服务 (server/) ──wss + HMAC-SHA256 签名──▶ 讯飞 iat.cn-huabei-1.xf-yun.com/v1
  AudioWorklet 重采样到 16k PCM            密钥只从环境变量读取；每个浏览器连接对应若干个上游会话，
  每帧 1280B/40ms                          自动续接（前端感知不到），并转发结果
```

## 会话续接（服务端负责，前端无感）
- 讯飞要求**单个会话不超过 60s**（超时报错 10114）。服务端在 **55s**（`ROTATE_MS`）时主动结束当前会话，同时开一个新会话。切换期间收到的音频先缓存，新会话建好后一起补发，不会丢字。
- 遇到停顿超过 `eos`（默认 1800ms），引擎会自动结束当前会话。之后再有声音（能量 ≥ `VAD_RMS`）时，服务端会带上前面 400ms 的预缓冲开一个新会话。静音期间不占用会话，也不消耗服务量。
- 每个会话结束时，把这一段的识别结果作为一条 `final` 发给前端。
- 已验证：一段 71.6s 的连续音频（中间有一次 3s 停顿）被拆成 3 段，接缝处没有丢字。

## 目录
```
server/index.js        HTTP 静态托管 + /asr WebSocket 中转（会话续接、能量门限、并发控制）+ /healthz
server/xfyun.js        签名（官方：host/date/request-line → HMAC-SHA256(APISecret) → Base64）、帧构造、wpgs 结果拼接、错误码
public/index.html      单页 UI（适配移动端）
public/app.js          开麦/停止、WebSocket、中间结果和最终结果渲染
public/pcm-worklet.js  AudioWorklet：任意采样率 → 16k Int16，每帧 640 个采样
test/xfyun.test.js     单元测试（npm test；签名用的是官方文档里的示例向量）
scripts/e2e-client.js  用 PCM 文件模拟实时推流，做端到端自测并统计延迟
scripts/mock-xfyun.js  本地 mock 讯飞 slm 协议（离线联调用，不消耗服务量）
samples/               TTS 生成的测试音频（普通话/粤语/东北话/陕西话）
```

## 启动
需要 Node ≥ 18，唯一的依赖是 `ws`。
```bash
cd speech-h5 && npm install
export XFYUN_APPID=...  XFYUN_API_KEY=...  XFYUN_API_SECRET=...   # 不要写进仓库文件
npm start                                                        # 默认监听 http://0.0.0.0:8080
npm test
npm run e2e -- samples/cantonese.pcm ws://localhost:8080/asr     # 设置了 ALLOWED_ORIGINS 时，还要加上 E2E_ORIGIN=<该 Origin>
# 离线联调：node scripts/mock-xfyun.js & XFYUN_ENDPOINT=ws://localhost:9000/v1 XFYUN_APPID=x XFYUN_API_KEY=x XFYUN_API_SECRET=x npm start
```

### 环境变量
| 变量 | 必填 | 说明 |
|---|---|---|
| `XFYUN_APPID` / `XFYUN_API_KEY` / `XFYUN_API_SECRET` | ✅ | 控制台「方言识别大模型」服务页上的 APPID / APIKey / APISecret |
| `PORT` / `HOST` | | 默认 8080 / 0.0.0.0 |
| `MAX_SESSIONS` | | 同时在用的路数，默认 2（要 ≤ 套餐并发数） |
| `MAX_SESSION_SEC` | | 单次录音最长时间，默认 600s（会自动续接多个 60s 会话） |
| `ALLOWED_ORIGINS` | | 逗号分隔的 Origin 白名单。不在名单里的 /asr 握手返回 403。公网部署时必须设置 |
| `ROTATE_MS` | | 主动续接的时间点，默认 55000 |
| `XFYUN_EOS` | | 尾部静音多长时间截断，单位 ms（600~10000），默认 1800。调大能减少会话数（更省服务量），但停顿后最终结果出得更慢 |
| `VAD_RMS` | | 空闲时开新会话的能量门限，默认 200。环境很安静、说话声音很小时可以调低 |
| `XFYUN_ENDPOINT` | | 只在本地 mock 测试时使用 |

密钥只从 `process.env` 读取，不会下发到前端，不写入文件。日志只打印错误码。

## HTTPS 要求
浏览器只在**安全上下文**里允许使用麦克风：`https://` 或 `http://localhost`。在手机上访问 `http://局域网IP:8080` **会被拒绝**。页面会根据当前协议自动选用 `wss://`。反向代理要放行 `/asr` 的 WebSocket 升级。

### 公网 HTTPS
1. **临时演示**：Cloudflare Quick Tunnel（不需要域名和备案）
   ```bash
   nohup cloudflared tunnel --no-autoupdate --url http://localhost:8080 > cloudflared.log 2>&1 &
   # 从日志里找到 https://xxxx.trycloudflare.com，再用它重启服务：
   ALLOWED_ORIGINS=https://xxxx.trycloudflare.com MAX_SESSIONS=2 nohup npm start > server.log 2>&1 &
   ```
   cloudflared 需要能**出站访问 7844 端口**（QUIC/UDP，或者加 `--protocol http2` 走 TCP）。只放行 443 的网络（例如某些沙箱或公司网络）里连不上，访问时会看到 Cloudflare 错误 1033/530。临时域名每次都会变，国内访问也不保证稳定。
2. **稳定试用（推荐）**：香港地域的轻量服务器 + Caddy（不需要备案，自动申请证书，自动支持 WebSocket）
   ```
   asr.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```
   用 pm2 或 systemd 守护进程。大陆地域的服务器要先做 ICP 备案。

## 识别结果协议（浏览器 ← 服务端）
`{type:'status', status:'ready'|'done'}`、`{type:'partial', text, seg}`、`{type:'final', text, seg}`、`{type:'error', code, message}`。浏览器发送二进制 PCM 帧，结束时发 `{type:'stop'}`。

## 计费与限制
- 按调用次数计费：**每个上游会话算 1 次**。在 eos=1800ms 下，大致每说一句（停顿超过 1.8s 算一句）计 1 次；连续说话时每 55s 计 1 次。
- 并发数以套餐为准（个人免费包是 2 路），超出时服务端直接提示“繁忙”。

## 常见错误（讯飞官方错误码）
| 码 | 含义 / 处理 |
|---|---|
| 11200 | 功能未授权：确认这个 APPID 下已经添加「方言识别大模型」，服务量和有效期也没有用完 |
| 11201 | 当天交互次数超过限制 |
| 10313 | appid 和 apikey 不匹配 |
| 10010 | 没有授权许可或者授权数已满（并发已满） |
| 10114 | 会话超过 60s（服务端已经自动续接，正常情况下不会出现） |
| 10200 | 累计 10s 没有发送数据 |
| 10139 / 10163 | 参数错误 / 参数校验失败 |
| 10009 / 10043 / 10160 / 10161 | 输入非法 / 音频解码失败 / JSON 非法 / base64 非法 |
| HTTP 401/403 | 签名错误或时间偏差超过 300s（用 NTP 校时），或者 APIKey 不对 |
