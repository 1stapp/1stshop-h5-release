/**
 * 海外 H5 的 Cloudflare Pages 中间件：给「商户自己 fork 公开仓库 global 分支、部署到自己的 Cloudflare Pages、
 * 绑定自己域名」的情况，做和国内 1stshop/middleware.js 一样的事：
 *   - 页面（/ 和 /pages/...）：按访问域名和路径问 API 拿标题、描述、分享图，写进 <head>
 *     （分享到 Facebook / WhatsApp 等的预览卡片、搜索引擎都读这里）
 *     同时写入结构化数据（JSON-LD）和正文快照，给不执行 JS 的 AI 抓取工具看（GEO）
 *   - /sitemap.xml、/robots.txt、/llms.txt、搜索引擎站长平台验证文件：按商户返回
 *   （/ads.txt 在 functions/ads.txt.js）
 *
 * 平台子域名（*.1stshops.com）和 CNAME 到 shop.1stshops.com 的自定义域名先经过 Worker「1stshop-h5-router」
 * （仓库存档 cloudflare/h5-router.js），那里已经做了这些事，并且对 Pages 的结果做了不分域名的共享缓存；
 * 那个 Worker 转发时带 X-Customer-Domain 请求头，这里见到就直接放行（在这里改写会被共享缓存串到别的店）。
 *
 * 只在 Cloudflare 上运行（请求带 request.cf）；万一 EdgeOne 也执行到这里就放行，国内由 middleware.js 处理。
 * 任何一步出错都返回原来的静态页面，不影响商城打开。
 */
const API = 'https://api.1stshops.com'; // functions/ 只发布到海外 global 分支

const isAsset = (pathname) => /\.[a-z0-9]{1,8}$/i.test(pathname);
const SITE_VERIFY_RE = /^\/(baidu_verify_[A-Za-z0-9_-]+\.html|google[0-9a-f]+\.html|BingSiteAuth\.xml|sogousiteverification\.txt|bdunion\.txt)$/;

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function proxyText(apiUrl, fallbackType, maxAge) {
  try {
    const res = await fetchWithTimeout(apiUrl, 5000);
    if (res.ok) {
      return new Response(await res.text(), {
        headers: { 'Content-Type': res.headers.get('Content-Type') || fallbackType, 'Cache-Control': `public, max-age=${maxAge}` },
      });
    }
  } catch (e) {}
  return null;
}

function robotsTxt(host) {
  const body = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /pages/user/',
    'Disallow: /pages/auth/',
    'Disallow: /pages/cart/',
    'Disallow: /pages/chat/',
    'Disallow: /pages/store/checkout',
    'Disallow: /pages/store/pay-result',
    '',
    `Sitemap: https://${host}/sitemap.xml`,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
}

const esc = (s) => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 结构化数据（schema.org JSON-LD）：JSON 里的 < 转成 \u003c，防止内容里的 </script> 提前结束标签 */
function ldTags(list) {
  if (!Array.isArray(list)) return '';
  return list.filter((x) => x && typeof x === 'object')
    .map((x) => `<script type="application/ld+json">${JSON.stringify(x).replace(/</g, '\\u003c')}</script>`)
    .join('\n    ');
}

/**
 * 页面正文的纯文字版：给不执行 JS 的搜索引擎 / AI 抓取工具看。放在 #app 外面（商城用 createSSRApp，
 * 放进 #app 会被当成服务端渲染结果去「激活」），浏览器执行到紧跟着的脚本就删掉，顾客看不到。
 */
function snapshotHtml(s) {
  if (!s || !s.heading) return '';
  const facts = (Array.isArray(s.facts) ? s.facts : [])
    .filter((f) => Array.isArray(f) && f[0] && f[1])
    .map((f) => `<li>${esc(f[0])}: ${esc(f[1])}</li>`).join('');
  const paras = String(s.text || '').split('\n').filter(Boolean).map((t) => `<p>${esc(t)}</p>`).join('');
  // 只认站内相对地址（/ 开头，且不是 // 或 /\ 这种会跳到别的网站的写法）
  const links = (Array.isArray(s.links) ? s.links : [])
    .filter((l) => l && l.text && /^\/(?![/\\])/.test(String(l.href || '')))
    .map((l) => `<li><a href="${esc(l.href)}">${esc(l.text)}</a></li>`).join('');
  return `<main id="seo-snapshot"><h1>${esc(s.heading)}</h1>${facts ? `<ul>${facts}</ul>` : ''}${paras}${links ? `<nav><ul>${links}</ul></nav>` : ''}</main>`
    + '<script>(function(){var e=document.getElementById("seo-snapshot");if(e)e.parentNode.removeChild(e)})()</script>';
}

/**
 * 把 SEO 信息写进 index.html：<head> 里的标题、描述、分享卡片、结构化数据，<body> 开头的正文快照。
 * 和 1stshop/functions/_middleware.js、cloudflare/h5-router.js 的 injectSeo 一致，改时三处一起改。
 * replace 一律用函数：内容里的 $& / $1 不会被当成替换模式。
 */
function injectSeo(html, seo) {
  // 标签页图标换成商户 logo（静态页里是平台 logo，搜索结果和收藏夹也读这里）
  if (seo.icon) {
    const iconTags = `<link rel="icon" href="${esc(seo.icon)}" />\n    <link rel="apple-touch-icon" href="${esc(seo.icon)}" />`;
    html = /<link[^>]*rel="icon"[^>]*>/i.test(html)
      ? html.replace(/<link[^>]*rel="icon"[^>]*>/i, () => iconTags)
      : html.replace(/<\/head>/i, () => `    ${iconTags}\n  </head>`);
  }
  const snapshot = snapshotHtml(seo.snapshot);
  if (snapshot) html = html.replace(/<body[^>]*>/i, (m) => `${m}\n    ${snapshot}`);
  const tags = [
    `<title>${esc(seo.title)}</title>`,
    '<meta name="x-seo" content="1" />', // 告诉前端：标题由服务器写好了，不要再覆盖成店铺名
    seo.description ? `<meta name="description" content="${esc(seo.description)}" />` : '',
    seo.keywords ? `<meta name="keywords" content="${esc(seo.keywords)}" />` : '',
    seo.url ? `<link rel="canonical" href="${esc(seo.url)}" />` : '',
    '<meta property="og:type" content="website" />',
    `<meta property="og:title" content="${esc(seo.title)}" />`,
    seo.description ? `<meta property="og:description" content="${esc(seo.description)}" />` : '',
    seo.image ? `<meta property="og:image" content="${esc(seo.image)}" />` : '',
    seo.url ? `<meta property="og:url" content="${esc(seo.url)}" />` : '',
    seo.siteName ? `<meta property="og:site_name" content="${esc(seo.siteName)}" />` : '',
    // X（Twitter）读 twitter:card 决定卡片样式，没有时只显示小图
    `<meta name="twitter:card" content="${seo.image ? 'summary_large_image' : 'summary'}" />`,
    ldTags(seo.jsonLd),
  ].filter(Boolean).join('\n    ');
  return /<title>[\s\S]*?<\/title>/i.test(html)
    ? html.replace(/<title>[\s\S]*?<\/title>/i, () => tags)
    : html.replace(/<\/head>/i, () => `    ${tags}\n  </head>`);
}

async function withSeo(pageRes, host, url) {
  const type = pageRes.headers.get('Content-Type') || '';
  if (pageRes.status !== 200 || !type.includes('text/html')) return pageRes;
  const path = url.pathname.replace(/^\/+/, '');
  const id = url.searchParams.get('id') || '';
  const seoUrl = `${API}/api/public/seo/${encodeURIComponent(host)}?path=${encodeURIComponent(path)}${id ? `&id=${encodeURIComponent(id)}` : ''}`;
  const [html, seoRes] = await Promise.all([pageRes.clone().text(), fetchWithTimeout(seoUrl, 1500).catch(() => null)]);
  if (!seoRes || !seoRes.ok) return pageRes;
  let seo = null;
  try { seo = await seoRes.json(); } catch (e) { seo = null; }
  if (!seo || !seo.title) return pageRes;
  return new Response(injectSeo(html, seo), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}

export async function onRequest(context) {
  const { request, next } = context;
  // 经过平台 Worker 的请求 / 不在 Cloudflare 上：交给别处
  if (!request.cf || request.headers.get('X-Customer-Domain')) return next();
  try {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const p = url.pathname;
    if (p === '/sitemap.xml') {
      const res = await proxyText(`${API}/api/public/sitemap/${encodeURIComponent(host)}`, 'application/xml; charset=utf-8', 3600);
      if (res) return res;
    } else if (p === '/robots.txt') {
      return robotsTxt(host);
    } else if (p === '/llms.txt') {
      const res = await proxyText(`${API}/api/public/llms-txt/${encodeURIComponent(host)}`, 'text/markdown; charset=utf-8', 3600);
      if (res) return res;
    } else if (SITE_VERIFY_RE.test(p)) {
      const res = await proxyText(`${API}/api/public/site-verify/${encodeURIComponent(host)}/${encodeURIComponent(p.slice(1))}`, 'text/plain; charset=utf-8', 300);
      if (res) return res;
    } else if (request.method === 'GET' && !isAsset(p)) {
      const pageRes = await next();
      try {
        return await withSeo(pageRes, host, url);
      } catch (e) {
        return pageRes; // 改写出错：原样返回静态页面
      }
    }
  } catch (e) {
    console.error('[_middleware] 出错，退回静态页面', e);
  }
  return next();
}
