/**
 * Google AdSense 的 ads.txt（https://商城域名/ads.txt）
 *
 * 所有商户共用同一份静态 H5，没法给每个商户放文件：带上访问域名问 API，
 * API 按该商户在 admin「广告参数设置 → 网站（Google AdSense）」填的发布商 ID 生成内容（routes/public/site-verify.ts）。
 *
 * 海外站部署在 Cloudflare Pages，靠这个 Pages Function 处理 /ads.txt（海外不经过 middleware.js）。
 * 商户的 *.1stshops.com 子域名先经过 Worker「1stshop-h5-router」再转发到 1stshop-h5.pages.dev，
 * 那个 Worker 会把原始域名放在 X-Customer-Domain 请求头里（而且它对转发结果做了不分域名的缓存，
 * 所以 /ads.txt 应在那个 Worker 里先行处理，这里是直接访问 Pages 自定义域时的兜底）。
 * 国内 EdgeOne Pages 由 middleware.js 处理；万一 EdgeOne 也执行到这里，按运行平台选 API：
 * Cloudflare 的请求带 request.cf，用海外 API，否则用国内 API。
 */
export async function onRequest(context) {
  const request = context.request;
  const host = request.headers.get('X-Customer-Domain') || new URL(request.url).hostname;
  const api = request.cf ? 'https://api.1stshops.com' : 'https://api.1stshop.cn';
  try {
    const res = await fetch(`${api}/api/public/ads-txt/${encodeURIComponent(host)}`);
    if (res.ok) {
      return new Response(await res.text(), {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
      });
    }
  } catch (e) {
    // API 出错时当作没有
  }
  return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
