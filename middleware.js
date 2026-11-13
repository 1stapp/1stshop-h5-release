/**
 * EdgeOne Pages 中间件（只在 EdgeOne Pages 上运行，uni-app 打包不会用到这个文件）
 *
 * 所有商户的 H5 是同一份静态网站，这里按访问域名做商户各自不同的内容：
 *
 * 1. /MP_verify_XXXX.txt：微信服务号「网页授权域名」验证文件。带上域名问 API，
 *    该域名对应的商户在 admin 上传过这个文件就返回内容，否则交给静态网站。
 * 2. 页面（/ 和 /pages/...）：SEO。取静态 index.html，按域名和路径问 API 拿标题、描述、关键词、分享图，
 *    写进 <head> 再返回。搜索引擎（尤其百度）不执行 JS，只能看到这里写进去的内容。
 * 3. /sitemap.xml、/robots.txt：每个商户自己的。
 * 4. 百度 / Google / Bing / 搜狗站长平台、百度联盟（bdunion.txt）的验证文件：商户在 admin「SEO 设置」上传，同样带域名问 API。
 * 5. 小程序业务域名（web-view）校验文件（微信 / 抖音 / 小红书的 .txt、支付宝的 32 位 .html）：
 *    商户在 admin「商家信息 → 合法域名配置」上传，走同一个 site-verify 接口。
 *
 * 商户自己部署到他的 EdgeOne 并绑定自己的域名时，同样带上他的域名来问，API 按 shops.domain 找到商户。
 * 任何一步出错都退回原来的静态页面，不影响商城打开。
 */

// EdgeOne 的 matcher 同时支持普通路径（'/about'）和正则；实测不带 [ ] ( ) * + 这类符号的正则
// （如 '^/sitemap\\.xml$'）不会被当成正则而匹配不上，所以普通路径和正则各写一份
export const config = {
  matcher: [
    '/',
    '/sitemap.xml',
    '/robots.txt',
    '/BingSiteAuth.xml',
    '/sogousiteverification.txt',
    '/bdunion.txt',
    '/ads.txt',
    // 正则每条只写一种，不要用 (a|b) 合并：实测合并后整条失效（服务号验证文件因此一度返回首页）
    '^/MP_verify_[A-Za-z0-9]+\\.txt$',
    '^/baidu_verify_[A-Za-z0-9_-]+\\.html$',
    '^/google[0-9a-f]+\\.html$',
    // 小程序业务域名（web-view）校验文件：微信 / 抖音 / 小红书是 字母数字.txt，支付宝是 32 位十六进制.html
    '^/[A-Za-z0-9]+\\.txt$',
    '^/[0-9A-Fa-f]+\\.html$',
    '^/pages/.*',
  ],
};

/** 国内 API；海外站域名为 *.1stshops.com（海外目前部署在 Cloudflare Pages，不经过这里，留着以防迁移） */
function apiBase(host) {
  return /(^|\.)1stshops\.com$/i.test(host) ? 'https://api.1stshops.com' : 'https://api.1stshop.cn';
}

/** 带超时的 fetch：API 慢的时候不拖慢页面，超时就当没有 */
async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const esc = (s) => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 把 SEO 信息写进 index.html 的 <head> */
function injectSeo(html, seo) {
  // 标签页图标换成商户 logo（静态页里是平台 logo，搜索结果和收藏夹也读这里）
  if (seo.icon) {
    const iconTags = `<link rel="icon" href="${esc(seo.icon)}" />\n    <link rel="apple-touch-icon" href="${esc(seo.icon)}" />`;
    html = /<link[^>]*rel="icon"[^>]*>/i.test(html)
      ? html.replace(/<link[^>]*rel="icon"[^>]*>/i, iconTags)
      : html.replace(/<\/head>/i, `    ${iconTags}\n  </head>`);
  }
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
  ].filter(Boolean).join('\n    ');
  return /<title>[\s\S]*?<\/title>/i.test(html)
    ? html.replace(/<title>[\s\S]*?<\/title>/i, tags)
    : html.replace(/<\/head>/i, `    ${tags}\n  </head>`);
}

async function handleVerifyFile(context, url, host) {
  const file = url.pathname.slice(1);
  const res = await fetch(`${apiBase(host)}/api/public/wechat-mp-verify/${encodeURIComponent(host)}/${encodeURIComponent(file)}`);
  if (!res.ok) return null;
  return new Response(await res.text(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}

// 小程序业务域名校验文件（规则细节在 API 的 routes/public/site-verify.ts）
const MINIAPP_VERIFY_RE = /^\/([A-Za-z0-9]{6,16}\.txt|[0-9A-Fa-f]{32}\.html)$/;
const SITE_VERIFY_RE =/^\/(baidu_verify_[A-Za-z0-9_-]+\.html|google[0-9a-f]+\.html|BingSiteAuth\.xml|sogousiteverification\.txt|bdunion\.txt)$/;

/** 搜索引擎验证文件：API 返回什么类型就原样返回；没上传过就交给静态网站 */
async function handleSiteVerify(url, host) {
  const file = url.pathname.slice(1);
  const res = await fetchWithTimeout(`${apiBase(host)}/api/public/site-verify/${encodeURIComponent(host)}/${encodeURIComponent(file)}`, 5000);
  if (!res.ok) return null;
  return new Response(await res.text(), {
    headers: { 'Content-Type': res.headers.get('Content-Type') || 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}

/** Google AdSense 的 ads.txt：按商户填的发布商 ID 生成（海外站由 functions/ads.txt.js 处理） */
async function handleAdsTxt(host) {
  const res = await fetchWithTimeout(`${apiBase(host)}/api/public/ads-txt/${encodeURIComponent(host)}`, 5000);
  if (!res.ok) return null;
  return new Response(await res.text(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}

async function handleSitemap(url, host) {
  const res = await fetchWithTimeout(`${apiBase(host)}/api/public/sitemap/${encodeURIComponent(host)}`, 5000);
  if (!res.ok) return null;
  return new Response(await res.text(), {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
  });
}

function handleRobots(host) {
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

async function handlePage(url, host) {
  // 静态 index.html（不在 matcher 里，不会再进中间件）和 SEO 信息同时取
  const path = url.pathname.replace(/^\/+/, '');
  const id = url.searchParams.get('id') || '';
  const seoUrl = `${apiBase(host)}/api/public/seo/${encodeURIComponent(host)}?path=${encodeURIComponent(path)}${id ? `&id=${encodeURIComponent(id)}` : ''}`;
  const [pageRes, seoRes] = await Promise.all([
    fetch(`${url.origin}/index.html`),
    fetchWithTimeout(seoUrl, 1500).catch(() => null),
  ]);
  if (!pageRes.ok) return null;
  const html = await pageRes.text();
  let seo = null;
  if (seoRes && seoRes.ok) {
    try { seo = await seoRes.json(); } catch (e) { seo = null; }
  }
  return new Response(seo && seo.title ? injectSeo(html, seo) : html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}

export async function middleware(context) {
  const { request, next } = context;
  try {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const p = url.pathname;
    let res = null;
    if (p.startsWith('/MP_verify_')) res = await handleVerifyFile(context, url, host);
    else if (SITE_VERIFY_RE.test(p)) res = await handleSiteVerify(url, host);
    else if (p === '/ads.txt') res = await handleAdsTxt(host);
    else if (p === '/sitemap.xml') res = await handleSitemap(url, host);
    else if (p === '/robots.txt') res = handleRobots(host);
    else if (MINIAPP_VERIFY_RE.test(p)) res = await handleSiteVerify(url, host);
    else if (request.method === 'GET') res = await handlePage(url, host);
    if (res) return res;
  } catch (e) {
    console.error('[middleware] 出错，退回静态页面', e);
  }
  return next();
}
