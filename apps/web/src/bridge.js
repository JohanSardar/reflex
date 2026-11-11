// The `reflex` bridge, as an Embed sees it (SPEC §5, ARCHITECTURE §5). It is the
// Embed's only way to the rest of Reflex, and it only ever reaches its own Element.
// The same file runs in the web viewer's sandboxed iframes and in the iPad's
// sandboxed WKWebViews (apps/ipad/Packages/ReflexEmbed links to it); the host
// fills in the config argument on the last line, {props, state, mcp?}, before the
// template's own scripts run. That last line is the only place the placeholder appears.
//
// Embed → host: {t: "ready" | "beat" | "setState" | "notify" | "emit" | "panel" |
//   "anchors" | "resolved" | "blocked" | "tool_call" | "mcp_message"}.
// Host → Embed: window.__reflexReceive({t: "resolve" | "rpc", ...}).
(function (cfg) {
  "use strict";
  var realParent = window.parent;
  var native = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.reflex;
  var post = function (m) {
    try {
      if (native) native.postMessage(m);
      else realParent.postMessage(Object.assign({ __reflex: 1 }, m), "*");
    } catch (e) {}
  };
  var LIMIT = 16384;
  var size = function (v) {
    try {
      return JSON.stringify(v === undefined ? null : v).length;
    } catch (e) {
      return Infinity;
    }
  };
  var clone = function (v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  };
  var blocked = function (what, detail) {
    post({ t: "blocked", what: what, detail: String(detail).slice(0, 300) });
  };
  var object = function (v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  };
  var state = object(cfg.state) ? cfg.state : {};
  var resolver = null;

  var reflex = {
    element: Object.freeze({
      /** This Element's parameters (and its data map, as `data`). */
      props: function () {
        return clone(cfg.props || {});
      },
      /** What this Embed saved with setState, on any device. */
      state: function () {
        return clone(state);
      },
      /** Saves state: it syncs to every device, survives reloads, and shows in the next Send. A null value removes that key. */
      setState: function (patch) {
        if (!object(patch)) throw new TypeError("reflex.element.setState takes an object");
        var next = Object.assign({}, state, patch);
        Object.keys(patch).forEach(function (k) {
          if (patch[k] === null) delete next[k];
        });
        if (size(next) > LIMIT) {
          blocked("state", "setState would save " + size(next) + " bytes; the limit is " + LIMIT);
          return false;
        }
        state = next;
        post({ t: "setState", patch: clone(patch) });
        return true;
      },
    }),
    /** A "notify agent" event: the Agent that placed this Embed gets it as a tap. */
    notify: function (payload) {
      if (payload !== undefined && !object(payload)) throw new TypeError("reflex.notify takes an object");
      if (size(payload) > LIMIT) return blocked("event", "notify payload over " + LIMIT + " bytes"), false;
      post({ t: "notify", payload: clone(payload || {}) });
      return true;
    },
    /** Fires this Element's embed_event Behaviors for `name`. */
    emit: function (name, payload) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(String(name))) throw new TypeError("reflex.emit: the event name must match ^[a-z][a-z0-9_]{0,39}$");
      if (payload !== undefined && !object(payload)) throw new TypeError("reflex.emit takes an object payload");
      if (size(payload) > LIMIT) return blocked("event", "emit payload over " + LIMIT + " bytes"), false;
      post({ t: "emit", name: String(name), payload: clone(payload || {}) });
      return true;
    },
    panel: Object.freeze({
      /** Opens a native Panel for this Element (common.schema.json#/$defs/panel). */
      open: function (spec) {
        if (!object(spec)) throw new TypeError("reflex.panel.open takes a Panel object");
        if (size(spec) > LIMIT) return blocked("panel", "Panel over " + LIMIT + " bytes"), false;
        post({ t: "panel", spec: clone(spec) });
        return true;
      },
    }),
    anchors: Object.freeze({
      /** `resolve(region)` gets a Mark's points and bounds in this Embed's pixels and says what it points at. */
      register: function (r) {
        if (!r || typeof r.resolve !== "function") throw new TypeError("reflex.anchors.register takes {resolve(region)}");
        resolver = r;
        post({ t: "anchors" });
      },
    }),
  };
  Object.defineProperty(window, "reflex", { value: Object.freeze(reflex), writable: false, configurable: false });

  // What the sandbox stopped, shown on the Embed so the person and its author can see it.
  document.addEventListener("securitypolicyviolation", function (e) {
    blocked("network", (e.blockedURI || "inline") + " (" + e.effectiveDirective + ")");
  });
  // The host stops an Embed whose page stops answering: a busy loop never lets this run.
  setInterval(function () {
    post({ t: "beat" });
  }, 1000);

  var receive = function (m) {
    if (!m || typeof m !== "object") return;
    if (m.t === "resolve") {
      Promise.resolve()
        .then(function () {
          return resolver ? resolver.resolve(m.region) : null;
        })
        .then(
          function (anchor) {
            post({ t: "resolved", id: m.id, anchor: anchor === undefined ? null : clone(anchor) });
          },
          function (err) {
            post({ t: "resolved", id: m.id, anchor: null, error: String(err).slice(0, 300) });
          },
        );
    } else if (m.t === "rpc" && mcp) mcp(m);
  };
  Object.defineProperty(window, "__reflexReceive", { value: receive, writable: false, configurable: false });
  if (!native)
    addEventListener("message", function (e) {
      if (e.source === realParent && e.data && e.data.__reflex === 2) receive(e.data);
    });

  // An MCP App view (a 'ui://' resource from another server): Reflex is its host. It
  // speaks JSON-RPC to window.parent, which here is the view itself, so nothing it
  // posts leaves the sandbox except through this bridge. Calls to its server's tools
  // are denied unless the person allowed that server; then they reach the Agent.
  var mcp = null;
  if (cfg.mcp) {
    try {
      window.parent = window;
    } catch (e) {}
    var reply = function (msg) {
      window.postMessage(Object.assign({ jsonrpc: "2.0" }, msg), "*");
    };
    var args = clone(cfg.props || {});
    var result = args && args.result;
    if (args) {
      delete args.result;
      delete args.data;
    }
    var pending = {};
    mcp = function (m) {
      var id = pending[m.id];
      delete pending[m.id];
      if (id === undefined) return;
      reply(m.error ? { id: id, error: m.error } : { id: id, result: m.result });
    };
    var n = 0;
    addEventListener("message", function (e) {
      var d = e.data;
      if (e.source !== window || !d || d.jsonrpc !== "2.0" || typeof d.method !== "string") return;
      // A request or notification from the view: only this bridge sees it.
      e.stopImmediatePropagation();
      var p = d.params || {};
      var answer = function (r) {
        if (d.id !== undefined) reply({ id: d.id, result: r });
      };
      var fail = function (code, message) {
        if (d.id !== undefined) reply({ id: d.id, error: { code: code, message: message } });
      };
      switch (d.method) {
        case "ui/initialize":
          return answer({
            protocolVersion: p.protocolVersion || "2025-06-18",
            hostInfo: { name: "Reflex", version: "0.1" },
            hostCapabilities: { serverTools: {}, logging: {} },
            hostContext: { theme: "light", displayMode: "inline", platform: native ? "mobile" : "web", viewport: { width: innerWidth, height: innerHeight } },
          });
        case "ui/notifications/initialized":
          reply({ method: "ui/notifications/tool-input", params: { arguments: args } });
          if (result !== undefined) reply({ method: "ui/notifications/tool-result", params: result });
          return;
        case "tools/call":
          if (d.id === undefined) return;
          pending["c" + ++n] = d.id;
          return post({ t: "tool_call", id: "c" + n, name: String(p.name || ""), arguments: clone(p.arguments || {}) });
        case "ui/message":
          post({ t: "mcp_message", message: clone(p) });
          return answer({});
        case "ui/open-link":
          blocked("link", "opening " + String(p.url || "a link") + " (Embeds don't open links)");
          return fail(-32000, "Reflex doesn't open links from an Embed.");
        case "ping":
          return answer({});
        case "notifications/message":
        case "ui/notifications/size-changed":
          return;
        default:
          return fail(-32601, "Reflex doesn't offer " + d.method + " to Embeds.");
      }
    });
  }
  post({ t: "ready" });
})(__REFLEX_CONFIG__);
