(() => {
  const $app = document.getElementById("app");
  const $who = document.getElementById("who");
  const $logout = document.getElementById("logout");

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const toast = (m) => { const t = document.getElementById("toast"); t.textContent = m; t.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 2200); };
  async function api(path, opts = {}) {
    const r = await fetch(path, { credentials: "same-origin", headers: { "content-type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
    let j = null; try { j = await r.json(); } catch {}
    if (!r.ok) throw new Error((j && j.error) || "Request failed (" + r.status + ")");
    return j;
  }
  const badge = (use, size) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 64 64"); s.setAttribute("width", size); s.setAttribute("height", size); const u = document.createElementNS("http://www.w3.org/2000/svg", "use"); u.setAttribute("href", "#" + use); s.append(u); return s; };
  const MOOD = { sniffing: ["🔎", "Sniffing around"], napping: ["💤", "Waiting (napping)"], nagging: ["📣", "Nagging"], worried: ["❓", "Needs you"], grumpy: ["💢", "Grumpy"], victory: ["🎉", "Victory!"] };
  const STATUS = { planning: "Planning", awaiting_approval: "Needs your OK", working: "Working", waiting: "Waiting", awaiting_confirmation: "Confirm it's done", resolved: "Resolved", stopped: "Stopped", stalled: "Stalled" };

  let user = null, timer = null;

  async function boot() {
    try { user = (await api("/api/me")).user; } catch { user = null; }
    paintWho();
    window.addEventListener("hashchange", route);
    route();
  }
  function paintWho() {
    $who.textContent = user ? (user.kind === "demo" ? "demo session" : user.email) : "";
    $logout.hidden = !user;
    $logout.onclick = async () => { await api("/api/auth/logout", { method: "POST" }); user = null; location.hash = "#/"; paintWho(); route(); };
  }
  function route() {
    clearInterval(timer);
    const m = /^#\/case\/([0-9a-f-]{36})$/.exec(location.hash);
    if (m) return caseView(m[1]);
    landing();
  }

  /* ------------------------------ landing ------------------------------ */
  async function landing() {
    $app.replaceChildren();
    const hero = h("section", { class: "hero" },
      h("div", {},
        h("div", { class: "kicker" }, "the agent that nags so you don't have to"),
        h("h1", { style: "margin-top:12px" }, "Someone owes you. ", h("em", {}, "Badger"), " will ask."),
        h("p", { class: "lead" }, "A friend with your $64. A gym that won't cancel. A landlord who ghosts. Badger researches your rights, writes each nudge for your approval, sends it from its own inbox, waits for the reply, and escalates. You never have to be the annoying one."),
      ),
      (() => { const w = h("div", { class: "bigbadger" }); w.append(badge("badger-face", "100%")); return w; })(),
    );
    $app.append(hero);
    $app.append(h("div", { class: "how" },
      h("div", {}, h("b", {}, "1. Research"), "Exa finds the policy and the rules, with exact quotes and links."),
      h("div", {}, h("b", {}, "2. Plan"), "A few well-spaced nudges that get firmer, never rude."),
      h("div", {}, h("b", {}, "3. You approve"), "Nothing goes out until you OK it. Edit anything."),
      h("div", {}, h("b", {}, "4. It waits and reads"), "Replies are understood. Promises are respected. Forms get filled in a live browser."),
    ));
    const cards = h("div", { class: "cards" });
    $app.append(h("h2", { style: "margin-top:30px" }, "Watch it work (sandbox, fast clock)"), cards);
    let sc = { scenarios: [], demoClock: { day_seconds: 12 } };
    try { sc = await api("/api/scenarios"); } catch {}
    for (const s of sc.scenarios) {
      const btn = h("button", { class: "btn" }, "Start this one →");
      btn.onclick = async () => {
        btn.disabled = true; btn.textContent = "Starting…";
        try {
          if (!user) { user = (await api("/api/auth/demo", { method: "POST" })).user; paintWho(); }
          const r = await api("/api/demo/start", { method: "POST", body: { scenario: s.key } });
          location.hash = "#/case/" + r.case.id;
        } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = "Start this one →"; }
      };
      cards.append(h("div", { class: "scn" }, h("div", { class: "em" }, s.emoji), h("h3", {}, s.label), h("p", {}, s.blurb), btn));
    }
    $app.append(h("p", { class: "clock", style: "margin-top:14px" }, "Sandbox clock: 1 day = " + sc.demoClock.day_seconds + " seconds. Real emails flow through AgentMail; the other side is a fictional character."));
    if (user) {
      try {
        const { cases } = await api("/api/cases");
        if (cases.length) $app.append(h("h2", { style: "margin-top:34px" }, "Your cases"), h("div", { class: "cards" }, cases.map((c) =>
          h("a", { class: "scn", href: "#/case/" + c.id, style: "text-decoration:none;color:inherit" }, h("h3", {}, c.title), h("span", { class: "pill s-" + c.status }, STATUS[c.status] || c.status), c.pending ? h("b", {}, c.pending + " waiting on you") : null))));
      } catch {}
    }
  }

  /* ------------------------------ case view ------------------------------ */
  async function caseView(id) {
    $app.replaceChildren(h("p", {}, "Loading…"));
    let last = "", approvalKey = "";
    const draw = async () => {
      let data;
      try { data = await api("/api/cases/" + id); } catch (e) { $app.replaceChildren(h("p", {}, e.message), h("a", { href: "#/" }, "Back")); clearInterval(timer); return; }
      const sig = JSON.stringify([data.case.updated_at, data.events.length, data.messages.length, data.actions.map((a) => a.id)]);
      if (sig === last) return;
      last = sig;
      const keep = $app.querySelector(".approve") && data.actions.map((a) => a.id).join() === approvalKey;
      render(data, keep);
      approvalKey = data.actions.map((a) => a.id).join();
    };
    await draw();
    timer = setInterval(draw, 2000);

    function render({ case: c, events, messages, actions }, keepApproval) {
      const mood = MOOD[c.mood] || MOOD.napping;
      const oldApprove = keepApproval ? $app.querySelector(".approve-wrap") : null;
      const left = h("div", {});
      const right = h("div", {});

      if (oldApprove) left.append(oldApprove);
      else if (actions.length) left.append(approvalBox(c, actions));

      left.append(h("div", { class: "box" }, h("h3", {}, "What's happening"), ...[...events].reverse().map((e) => eventRow(e))));

      right.append(h("div", { class: "box" }, h("h3", {}, "The plan"),
        c.clock_scale > 1 ? h("div", { class: "clock" }, "Sandbox clock: 1 day = " + Math.round(86400 / c.clock_scale) + "s") : null,
        c.summary ? h("p", { style: "font-size:14px;color:var(--ink2)" }, c.summary) : null,
        ...c.plan.map((s) => h("div", { class: "step " + s.status }, h("span", { class: "n" }, "Day " + s.day), h("span", {}, s.label, s.needs_approval && s.status === "pending" ? " 🔒" : "")))));

      const r = c.research || {};
      const srcs = [...(r.policies || []).map((p) => [p.claim, p.quote, p.url]), ...(r.clocks || []).map((p) => [p.label + (p.days ? " (" + p.days + " days)" : ""), p.quote, p.url])];
      if (srcs.length) right.append(h("div", { class: "box" }, h("h3", {}, "Sourced facts (Exa)"), ...srcs.slice(0, 5).map(([t, q, u]) => h("div", { class: "src" }, h("b", {}, t), h("div", {}, "“" + q.slice(0, 220) + "”"), h("a", { href: u, target: "_blank", rel: "noopener noreferrer" }, new URL(u).hostname)))));

      if (messages.length) right.append(h("div", { class: "box" }, h("h3", {}, "The thread"), ...messages.map((m) => h("div", { class: "msg " + m.direction }, h("small", {}, (m.direction === "out" ? "Badger → " : "← ") + c.counterparty_name), m.body.replace(/\n--\nSent by Badger[\s\S]*$/, "")))));

      const actionsRow = h("div", { class: "row" });
      if (!["resolved", "stopped"].includes(c.status)) {
        actionsRow.append(h("button", { class: "btn ghost sm", onclick: async () => { await api("/api/cases/" + id + "/stop", { method: "POST" }); last = ""; draw(); } }, "Stop this case"));
      }

      $app.replaceChildren(
        h("a", { href: "#/", style: "font-size:14px" }, "← all cases"),
        h("div", { class: "case-head" },
          (() => { const w = h("div", { class: "mascot" }); w.append(badge("badger-face", 84)); return w; })(),
          h("div", {}, h("h2", {}, c.title), h("div", { style: "margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center" }, h("span", { class: "pill s-" + c.status }, STATUS[c.status] || c.status), h("span", { class: "pill" }, mood[0] + " " + mood[1]), h("span", { style: "color:var(--ink2);font-size:14px" }, "chasing " + c.counterparty_name + " · " + c.emails_sent + " sent"))),
          h("span", { class: "grow" }), actionsRow),
        h("div", { class: "grid" }, left, right),
      );
    }

    function eventRow(e) {
      const body = [];
      if (e.body) body.push(h("div", { class: "b" }, e.body.length > 420 ? e.body.slice(0, 420) + "…" : e.body));
      if (e.meta && e.meta.live_view_url) body.push(h("iframe", { class: "live", src: e.meta.live_view_url, allow: "clipboard-read; clipboard-write" }));
      if (e.meta && e.meta.screenshot) body.push(h("img", { class: "shot", src: e.meta.screenshot, alt: "Screenshot of the submitted form" }));
      return h("div", { class: "ev " + e.type }, h("span", { class: "dot" }), h("div", {}, h("div", { class: "t" }, e.title, " ", h("time", {}, new Date(e.ts).toLocaleTimeString())), ...body));
    }

    function approvalBox(c, actions) {
      const wrap = h("div", { class: "approve-wrap" });
      for (const a of actions) {
        const box = h("div", { class: "box approve" });
        const decide = async (decision, extra = {}) => {
          box.querySelectorAll("button").forEach((b) => (b.disabled = true));
          try { await api("/api/actions/" + a.id + "/decide", { method: "POST", body: { decision, ...extra } }); toast(decision === "approve" ? "Done. Badger is on it." : "Skipped."); last = ""; draw(); }
          catch (e) { toast(e.message); box.querySelectorAll("button").forEach((b) => (b.disabled = false)); }
        };
        if (a.kind === "confirm_resolution") {
          box.append(h("h3", {}, "They say it's sorted 🎉"), h("p", {}, a.draft.summary || ""), h("p", { style: "color:var(--ink2);font-size:14px" }, "Check that it's really done (money received, cancellation confirmed), then tell Badger."),
            h("div", { class: "row" }, h("button", { class: "btn green", onclick: () => decide("approve") }, "Yes, it's sorted"), h("button", { class: "btn ghost", onclick: () => decide("skip") }, "Not yet")));
        } else if (a.kind === "need_info") {
          const inp = h("input", { placeholder: "Your answer" });
          box.append(h("h3", {}, "Badger needs you"), h("p", {}, a.draft.question || ""), inp, h("div", { class: "row" }, h("button", { class: "btn", onclick: () => decide("approve", { answer: inp.value }) }, "Send answer")));
        } else {
          const subj = h("input", { value: a.draft.subject || "" });
          const body = h("textarea", {}); body.value = a.draft.body || "";
          const what = a.kind === "web_form" ? "Badger will fill in their web form in a live browser" : a.kind === "escalate_email" ? "Escalation to " + a.draft.to : "Email to " + c.counterparty_name;
          box.append(h("h3", {}, "✋ Your OK needed: " + what), h("p", { style: "font-size:14px;color:var(--ink2)" }, a.draft.note || "Nothing goes out until you approve. Edit freely."), a.kind === "web_form" ? null : subj, body,
            h("div", { class: "row" }, h("button", { class: "btn", onclick: () => decide("approve", { subject: subj.value, body: body.value }) }, a.kind === "web_form" ? "Approve & fill the form" : "Approve & send"), h("button", { class: "btn ghost", onclick: () => decide("skip") }, "Skip this step")));
        }
        wrap.append(box);
      }
      return wrap;
    }
  }

  boot();
})();
