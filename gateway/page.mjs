import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { escape } from "./access-pages.mjs";

const built = new URL("../dashboard/build/asafarim-theme/", import.meta.url);
const source = new URL("../dashboard/static/asafarim-theme/", import.meta.url);
const assetRoot = existsSync(fileURLToPath(new URL("theme.js", built)))
  ? built
  : source;
const toggle = readFileSync(new URL("toggle.html", assetRoot), "utf8");
const assets = new Map([
  [
    "/asafarim-theme/theme.js",
    {
      type: "text/javascript; charset=utf-8",
      body: readFileSync(new URL("theme.js", assetRoot)),
    },
  ],
  [
    "/asafarim-theme/theme.css",
    {
      type: "text/css; charset=utf-8",
      body: readFileSync(new URL("theme.css", assetRoot)),
    },
  ],
]);
export const themeAsset = (pathname) => assets.get(pathname);

export function page(title, content) {
  const current =
    title === "Your Observatory access"
      ? "/access"
      : title === "Your ASafariM session"
        ? "/account"
        : title === "Your workspace, in perspective."
          ? "/login"
          : "";
  const link = (href, label) =>
    `<a href="${href}"${current === href ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Observatory</title><link rel="stylesheet" href="/asafarim-theme/theme.css"><script src="/asafarim-theme/theme.js"></script><style>
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px system-ui;min-height:100vh;display:flex;flex-direction:column}a{color:var(--accent);text-underline-offset:3px}button{font:inherit;cursor:pointer}a:focus-visible,button:focus-visible,textarea:focus-visible{outline:3px solid var(--accent);outline-offset:4px}.skip{position:absolute;top:-60px;left:12px;padding:12px;background:var(--card);z-index:10}.skip:focus{top:12px}.gateway-topbar{display:flex;align-items:center;gap:20px;padding:16px max(20px,calc((100vw - 1100px)/2));border-bottom:1px solid var(--top-line);flex-wrap:wrap}.gateway-brand{font-weight:750;text-decoration:none;white-space:nowrap;color:var(--top-ink)}.gateway-brand span{color:var(--brand-a);font-size:25px;vertical-align:middle;margin-right:6px}.gateway-nav{display:flex;gap:8px;flex-wrap:wrap;flex:1}.gateway-nav a{display:inline-block;padding:9px 12px;border-radius:6px;text-decoration:none;color:var(--top-muted)}.gateway-nav a:hover,.gateway-nav a[aria-current]{background:var(--top-card);color:var(--top-ink)}.gateway-main{width:min(100% - 40px,900px);margin:36px auto;padding:28px;border:1px solid var(--line);border-radius:12px;background:var(--card);overflow-wrap:anywhere;flex:1}.gateway-main h1{font-size:clamp(1.6rem,5vw,2rem);margin:10px 0 20px}.gateway-main h2{margin-top:28px}.gateway-main p{line-height:1.7;color:var(--muted)}.gateway-main button{display:inline-block;background:var(--accent);color:var(--accent-ink);border:0;border-radius:6px;padding:12px 18px;margin-top:8px}.gateway-main form{margin-top:18px}.gateway-main textarea{display:block;width:100%;box-sizing:border-box;margin:12px 0;padding:12px;font:inherit;background:var(--card-2);color:var(--ink);border:1px solid var(--line);border-radius:6px}.gateway-main article{border-top:1px solid var(--line);margin-top:24px;padding-top:12px}.gateway-main small{color:var(--muted)}.gateway-footer{padding:20px;display:flex;align-items:center;justify-content:center;gap:12px 20px;flex-wrap:wrap;border-top:1px solid var(--line);color:var(--muted);font-size:13px}.gateway-footer nav{display:flex;gap:16px;flex-wrap:wrap}@media(max-width:600px){.gateway-topbar{gap:12px;padding:12px 16px}.gateway-nav{order:3;flex-basis:100%}.gateway-topbar>.os-theme-toggle{margin-left:auto}.gateway-main{width:calc(100% - 24px);margin:20px auto;padding:20px}.gateway-nav a{padding:9px}.gateway-footer{justify-content:flex-start}}
  </style></head><body><a class="skip" href="#main">Skip to content</a><header class="os-topbar gateway-topbar"><a class="gateway-brand" href="/"><span aria-hidden="true">◎</span>ASafariM Observatory</a><nav class="gateway-nav" aria-label="Observatory navigation">${link("/", "Dashboard")}${link("/access", "Access")}${link("/account", "Account")}</nav>${toggle}</header><main id="main" class="gateway-main"><small>ASafariM OBSERVATORY</small><h1>${escape(title)}</h1>${content}</main><footer class="gateway-footer"><span>ASafariM Observatory · Gateway v0.2.2</span><nav aria-label="Footer navigation"><a href="https://asafarim.site/">ASafariM home</a><a href="https://asafarim.site/privacy">Privacy</a><a href="https://asafarim.site/cookies">Cookies</a><a href="https://asafarim.site/terms">Terms</a></nav></footer></body></html>`;
}
