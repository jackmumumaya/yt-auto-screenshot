import puppeteer from "@cloudflare/puppeteer";
import jsQR from "jsqr";

export default {
    async fetch(request, env) {
        try {
            const url = new URL(request.url);
            if (url.pathname === "/admin") return await this.handleAdmin(request, env);
            return await this.processVideos(env);
        } catch (e) {
            // 针对 429 频率限制提供友好的 UI 提示，避免 1101
            const isRateLimit = e.message.includes("429");
            return new Response(`
                <div style="padding:40px; font-family:sans-serif; text-align:center;">
                    <div style="font-size:50px;">${isRateLimit ? '⏳' : '❌'}</div>
                    <h2 style="color:#d9534f;">${isRateLimit ? '触发启动频率限制' : '系统运行错误'}</h2>
                    <p style="color:#666;">${isRateLimit ? 'Cloudflare 限制了浏览器的启动频率。' : e.message}</p>
                    <p><b>建议方案：</b>请静候 <span style="color:red; font-weight:bold;">5-10 分钟</span>后再刷新。期间请勿频繁点击。</p>
                    <button onclick="location.reload()" style="padding:10px 20px; background:#007bff; color:white; border:none; border-radius:5px; cursor:pointer;">刷新页面</button>
                </div>
            `, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
        }
    },

    async handleAdmin(request, env) {
        const ADMIN_PASSWORD = "admin"; 
        if (request.method === "POST") {
            const data = await request.formData();
            if (data.get("password") !== ADMIN_PASSWORD) return new Response("密码错误", { status: 403 });
            const urls = data.get("urls").split("\n").map(u => u.trim()).filter(u => u.startsWith("http"));
            await env.URL_KV.put("TARGET_URLS", JSON.stringify(urls));
            return new Response("<script>alert('保存成功！请务必等待几分钟后再查看首页');location.href='/admin';</script>", { headers: { "Content-Type": "text/html;charset=UTF-8" } });
        }
        let displayUrls = ["https://www.youtube.com/watch?v=V1nVrDSZmSE"];
        const stored = await env.URL_KV.get("TARGET_URLS");
        if (stored) displayUrls = JSON.parse(stored);

        return new Response(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>管理</title><style>body{font-family:sans-serif;padding:30px;background:#f4f4f9;}.box{background:#fff;padding:20px;border-radius:8px;max-width:500px;margin:auto;box-shadow:0 2px 10px rgba(0,0,0,0.1);}textarea{width:100%;height:120px;margin:10px 0;box-sizing:border-box;}button{width:100%;padding:10px;background:#007bff;color:#fff;border:none;border-radius:4px;cursor:pointer;width:100%;}</style></head><body><div class="box"><h2>⚙️ 监控列表管理</h2><p style="font-size:12px;color:red;">注意：免费版建议仅保留 1 个链接</p><form method="POST"><textarea name="urls">${displayUrls.join("\n")}</textarea><input type="password" name="password" placeholder="密码" style="width:100%;margin-bottom:10px;padding:8px;box-sizing:border-box;"><button type="submit">保存更新并冷却系统</button></form></div></body></html>`, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    },

    async processVideos(env) {
        const subConverterBase = "https://sb.leelaotou.us.kg";
        let videoUrls = ["https://www.youtube.com/watch?v=V1nVrDSZmSE"];
        const stored = await env.URL_KV.get("TARGET_URLS");
        if (stored) videoUrls = JSON.parse(stored);

        // 【核心限制】在免费版环境，强制只处理第一个链接以保证成功率
        const targetUrl = videoUrls[0];
        if (!targetUrl) return new Response("请先到后台添加链接");

        const browser = await puppeteer.launch(env.BROWSER);
        try {
            const page = await browser.newPage();
            // 拦截所有无关资源
            await page.setRequestInterception(true);
            page.on('request', r => ['image','stylesheet','font','media'].includes(r.resourceType()) && r.resourceType() !== 'media' ? r.abort() : r.continue());

            await page.setViewport({ width: 640, height: 360 });
            await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 20000 });
            
            // 播放并等待
            await page.evaluate(() => { const v = document.querySelector('video'); if(v) v.play(); });
            await new Promise(r => setTimeout(r, 5000));

            const res = await page.evaluate(() => {
                const v = document.querySelector('video');
                if(!v) return null;
                const canvas = document.createElement('canvas');
                canvas.width = 480; canvas.height = 270;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(v, 0, 0, 480, 270);
                return {
                    pixels: Array.from(ctx.getImageData(0, 0, 480, 270).data),
                    w: 480, h: 270,
                    img: canvas.toDataURL('image/jpeg', 0.2)
                };
            });

            if (!res) throw new Error("无法获取视频流");

            const code = jsQR(new Uint8ClampedArray(res.pixels), res.w, res.h);
            if (!code) throw new Error("当前画面未检测到二维码");

            const encoded = encodeURIComponent(code.data);
            const links = {
                "V2Ray": `${subConverterBase}/xray?config=${encoded}`,
                "Clash": `${subConverterBase}/sub?target=clash&url=${encoded}`,
                "Sing-box": `${subConverterBase}/sub?target=singbox&url=${encoded}`
            };

            return new Response(this.renderUI(links, res.img), { headers: { "Content-Type": "text/html;charset=UTF-8" } });

        } finally {
            await browser.close();
        }
    },

    renderUI(links, img) {
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>节点面板</title><style>body{font-family:sans-serif;background:#f0f2f5;display:flex;flex-direction:column;align-items:center;padding:20px;}.card{background:#fff;border-radius:12px;padding:20px;width:100%;max-width:400px;box-shadow:0 4px 15px rgba(0,0,0,0.05);}img{width:100%;border-radius:8px;}input{width:60%;font-size:10px;margin-right:5px;}</style></head><body><div class="card"><h3>📷 实况截图</h3><img src="${img}"><hr><h3>🔗 订阅链接</h3>${Object.entries(links).map(([n, u]) => `<div style="margin:10px 0;"><p style="font-size:12px;margin:0;">${n}</p><input type="text" value="${u}" id="${n}"><button onclick="copy('${n}')">复制</button></div>`).join('')}</div><br><a href="/admin" style="color:#999;text-decoration:none;font-size:12px;">⚙️ 管理后台</a><script>function copy(id){const i=document.getElementById(id);i.select();navigator.clipboard.writeText(i.value);alert('已复制');}</script></body></html>`;
    }
};
