const ROUTES = {
  "/fleshup": "https://fleshup.netlify.app",
  "/100-dayjourney": "https://100-dayjourney.netlify.app",
  "/365daymealplan": "https://365daymealplan.netlify.app",
  "/freemealplan": "https://freemealplan.netlify.app",
};

function matchRoute(pathname) {
  for (const prefix of Object.keys(ROUTES)) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) {
      return prefix;
    }
  }
  return null;
}

function buildUpstreamHeaders(reqHeaders) {
  const allowlist = [
    "accept",
    "accept-language",
    "user-agent",
    "cookie",
    "if-none-match",
    "if-modified-since",
    "range",
  ];
  const headers = new Headers();
  for (const [key, value] of reqHeaders.entries()) {
    if (allowlist.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  return headers;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteBody(body, prefix, targetOrigin) {
  // Rewrite any absolute references to the upstream origin back to the proxy prefix
  const originRegex = new RegExp(escapeRegExp(targetOrigin), "g");
  body = body.replace(originRegex, prefix);

  // Rewrite root-relative href/src/action attributes: href="/x" -> href="/prefix/x"
  body = body.replace(
    /((?:href|src|action)\s*=\s*["'])\/(?!\/)/g,
    `$1${prefix}/`
  );

  // Rewrite srcset attributes which can contain multiple comma-separated URLs
  body = body.replace(/(srcset\s*=\s*["'])([^"']+)(["'])/g, (full, p1, p2, p3) => {
    const rewritten = p2
      .split(",")
      .map((part) => part.replace(/^(\s*)\/(?!\/)/, `$1${prefix}/`))
      .join(",");
    return p1 + rewritten + p3;
  });

  // Rewrite CSS url(/x) references (inline styles or <style> blocks)
  body = body.replace(/url\((['"]?)\/(?!\/)/g, `url($1${prefix}/`);

  return body;
}

function rewriteLocationHeader(location, prefix, targetOrigin, requestOrigin) {
  if (!location) return location;
  if (location.startsWith(targetOrigin)) {
    return location.replace(targetOrigin, prefix);
  }
  if (location.startsWith("/") && !location.startsWith("//")) {
    return `${prefix}${location}`;
  }
  return location;
}

export default async (request) => {
  const url = new URL(request.url);
  const prefix = matchRoute(url.pathname);

  if (!prefix) {
    return new Response("Not found", { status: 404 });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const targetOrigin = ROUTES[prefix];
  const remainder = url.pathname.slice(prefix.length) || "/";
  const targetUrl = new URL(remainder + url.search, targetOrigin);

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: buildUpstreamHeaders(request.headers),
      redirect: "manual",
    });
  } catch (err) {
    return new Response("Bad gateway", { status: 502 });
  }

  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.delete("content-length");
  responseHeaders.delete("content-encoding");

  // Handle upstream redirects, rewriting Location so the browser stays on creatora.online
  if ([301, 302, 303, 307, 308].includes(upstreamResponse.status)) {
    const location = upstreamResponse.headers.get("location");
    const rewrittenLocation = rewriteLocationHeader(
      location,
      prefix,
      targetOrigin,
      url.origin
    );
    if (rewrittenLocation) {
      responseHeaders.set("location", rewrittenLocation);
    }
    return new Response(null, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  }

  const contentType = upstreamResponse.headers.get("content-type") || "";
  const isRewritable =
    contentType.includes("text/html") || contentType.includes("text/css");

  if (isRewritable) {
    const originalBody = await upstreamResponse.text();
    const rewritten = rewriteBody(originalBody, prefix, targetOrigin);
    return new Response(request.method === "HEAD" ? null : rewritten, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  }

  if (request.method === "HEAD") {
    return new Response(null, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
};

export const config = {
  path: [
    "/fleshup",
    "/fleshup/*",
    "/100-dayjourney",
    "/100-dayjourney/*",
    "/365daymealplan",
    "/365daymealplan/*",
    "/freemealplan",
    "/freemealplan/*",
  ],
};
