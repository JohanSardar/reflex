// The `ui://reflex/space` view (agent/src/surfaces/app.ts): one HTML page,
// no dependencies, talking to its host over postMessage JSON-RPC as the MCP
// Apps extension (2026-01-26) describes.
export const VIEW_HTML = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reflex Space</title>
<style>
  :root {
    --bg: var(--color-background-primary, #fff);
    --fg: var(--color-text-primary, #1d1d1f);
    --muted: var(--color-text-secondary, #6e6e73);
    --line: var(--color-border-primary, #d9d9de);
    --accent: #6e56cf;
    color-scheme: light dark;
  }
  :root[data-theme="dark"] { --bg: var(--color-background-primary, #1c1c1e); --fg: var(--color-text-primary, #f2f2f7); --muted: var(--color-text-secondary, #a1a1a6); --line: var(--color-border-primary, #3a3a3c); }
  html, body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.4 var(--font-sans, -apple-system, system-ui, sans-serif); }
  main { padding: 10px 12px 12px; }
  header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
  header b { font-size: 14px; }
  header span { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #canvas { border: 1px solid var(--line); border-radius: 8px; background: #fff; min-height: 80px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  #canvas img { display: block; max-width: 100%; height: auto; }
  #canvas em { color: #8e8e93; padding: 24px; }
  #status { margin-top: 8px; color: var(--muted); display: flex; gap: 6px; align-items: center; }
  #status i { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
  #status.live i { background: #30a46c; }
  #status.error i { background: #e5484d; }
  ul { margin: 6px 0 0; padding: 0; list-style: none; color: var(--muted); }
  li { padding: 2px 0; }
  li b { color: var(--fg); font-weight: 500; }
</style>
</head>
<body>
<main>
  <header><b>Reflex</b><span id="title">waiting for the Space…</span></header>
  <div id="canvas"><em>Loading the Space…</em></div>
  <div id="status"><i></i><span id="say">Connecting…</span></div>
  <ul id="sends"></ul>
</main>
<script>
(function () {
  var nextId = 1, waiting = {}, space = null, stopped = false, started = false, lastLook = 0;
  var $ = function (id) { return document.getElementById(id); };

  function post(msg) { window.parent.postMessage(msg, "*"); }
  function rpc(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      waiting[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: "2.0", id: id, method: method, params: params });
    });
  }
  function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function status(text, kind) { $("say").textContent = text; $("status").className = kind || ""; }

  function textOf(result) {
    var t = (result && result.content || []).filter(function (c) { return c.type === "text"; })[0];
    try { return t ? JSON.parse(t.text) : {}; } catch (e) { return {}; }
  }
  function imagesOf(result) { return (result && result.content || []).filter(function (c) { return c.type === "image"; }); }
  function errorOf(j) { return (j.errors && j.errors[0] && j.errors[0].msg) || j.reason || "the call failed"; }

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && !m.method) {
      var w = waiting[m.id];
      if (!w) return;
      delete waiting[m.id];
      if (m.error) w.reject(new Error(m.error.message || "error")); else w.resolve(m.result);
      return;
    }
    if (m.method === "ui/notifications/tool-input") begin(m.params && m.params.arguments && m.params.arguments.space);
    else if (m.method === "ui/notifications/tool-result") { var j = textOf(m.params); begin(j.space); }
    else if (m.method === "ui/notifications/host-context-changed") theme(m.params);
    else if (m.method === "ui/notifications/tool-cancelled") status("The Agent's call was cancelled.", "error");
    else if (m.method === "ui/resource-teardown") { stopped = true; post({ jsonrpc: "2.0", id: m.id, result: {} }); }
    else if (m.method === "ping") post({ jsonrpc: "2.0", id: m.id, result: {} });
    else if (m.id !== undefined) post({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
  });

  function theme(ctx) {
    if (ctx && ctx.theme) document.documentElement.setAttribute("data-theme", ctx.theme);
    var vars = ctx && ctx.styles && ctx.styles.variables;
    if (vars) for (var k in vars) if (vars[k]) document.documentElement.style.setProperty(k, vars[k]);
  }

  function call(name, args) {
    return rpc("tools/call", { name: name, arguments: args }).then(function (r) {
      var j = textOf(r);
      if (r && r.isError) throw new Error(errorOf(j));
      return { json: j, images: imagesOf(r) };
    });
  }

  function look() {
    lastLook = Date.now();
    return call("look", { space: space, width: 960 }).then(function (r) {
      var img = r.images[0];
      if (img) $("canvas").innerHTML = '<img alt="The Space ' + space + '" src="data:' + (img.mimeType || "image/png") + ";base64," + img.data + '">';
      else $("canvas").innerHTML = "<em>The Space is empty.</em>";
    }, function (e) { status("Couldn't show the Space: " + e.message, "error"); });
  }

  function sentLine(b, how) {
    var li = document.createElement("li");
    li.innerHTML = "<b></b> <span></span>";
    li.firstChild.textContent = (b.from && b.from.name || "The person") + " · " + b.send;
    li.lastChild.textContent = how;
    $("sends").insertBefore(li, $("sends").firstChild);
    while ($("sends").children.length > 5) $("sends").removeChild($("sends").lastChild);
  }

  // A Send becomes the person's next message in this chat.
  function toChat(b, images) {
    var copy = JSON.parse(JSON.stringify(b));
    copy.next = "Answer it in the Space with apply(space: '" + b.space + "', in_reply_to: '" + b.send + "') if it needs an answer, then end your turn. Don't call wait_for_user: the Reflex view in this chat posts the person's next Send here the same way.";
    var who = b.from && b.from.name || "The person";
    var text = "[Reflex] " + who + " pressed Send in the Space '" + b.space + "' (" + b.send + ")" + (b.said ? ': "' + b.said + '"' : "") + "." +
      (images.length ? " The crops are attached, in the order of images[]." : "") +
      "\n\nSend Bundle:\n" + JSON.stringify(copy) + "\n\n" + copy.next;
    var content = [{ type: "text", text: text }].concat(images.map(function (i) { return { type: "image", data: i.data, mimeType: i.mimeType || "image/png" }; }));
    return rpc("ui/message", { role: "user", content: content }).catch(function (e) {
      // A host that takes only text gets the Bundle without its crops.
      if (!images.length) throw e;
      return rpc("ui/message", { role: "user", content: [content[0]] });
    });
  }

  // Once the host took a Send into the chat, the Agent has it in its conversation: the view's next wait
  // acknowledges it (after), so it isn't handed out again. A Send the host refused stays pending for the Agent.
  async function listen() {
    var backoff = 2000, ack = null, posted = {}, refused = {};
    while (!stopped) {
      status("Live. Press Send on your iPad and it arrives in this chat.", "live");
      try {
        var args = { space: space, timeout_s: 25 };
        if (ack) args.after = ack;
        var r = await call("wait_for_user", args);
        ack = null;
        backoff = 2000;
        var b = r.json;
        if (b.status === "still_waiting" || !b.send) {
          if (!document.hidden && Date.now() - lastLook > 20000) look();
          continue;
        }
        if (posted[b.send]) { ack = b.send; continue; }
        if (refused[b.send]) {
          // The oldest pending Send is one the host won't take: leave it, and the rest, to the Agent.
          status("This host doesn't take messages from the view; Sends wait for the Agent's wait_for_user.", "error");
          return;
        }
        status("Posting " + b.send + " to the chat…", "live");
        try {
          await toChat(b, r.images);
          posted[b.send] = true;
          ack = b.send;
          sentLine(b, "posted to the chat");
        } catch (e) {
          refused[b.send] = true;
          sentLine(b, "the host didn't take it (" + e.message + "); it stays pending for the Agent");
        }
        look();
      } catch (e) {
        status("Not hearing Sends right now: " + e.message + ". Trying again…", "error");
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60000);
      }
    }
    status("Closed.", "");
  }

  function begin(name) {
    if (started || !name) return;
    started = true;
    space = name;
    $("title").textContent = name;
    look().then(listen);
  }

  new ResizeObserver(function () {
    var el = document.documentElement;
    notify("ui/notifications/size-changed", { width: el.scrollWidth, height: el.scrollHeight });
  }).observe(document.body);

  rpc("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "reflex-space", version: "0.1.0" }, appCapabilities: { availableDisplayModes: ["inline"] } })
    .then(function (r) {
      theme(r && r.hostContext);
      notify("ui/notifications/initialized", {});
      status("Waiting for the Agent's open_space…", "");
    }, function (e) { status("The host didn't start the view: " + e.message, "error"); });
})();
</script>
</body>
</html>`;
