(() => {
  const $app = document.getElementById("app");
  const $who = document.getElementById("who");
  const $logout = document.getElementById("logout");
  const SVGNS = "http://www.w3.org/2000/svg";

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
  const sym = (id, size, cls) => {
    const s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("viewBox", id.startsWith("bf-") ? "0 0 64 64" : "0 0 32 32");
    s.setAttribute("width", size); s.setAttribute("height", size); s.setAttribute("aria-hidden", "true");
    if (cls) s.setAttribute("class", cls);
    const u = document.createElementNS(SVGNS, "use"); u.setAttribute("href", "#" + id); s.append(u);
    return s;
  };
  const face = (mood, size, cls) => sym("bf-" + (FACES.includes(mood) ? mood : "neutral"), size, cls);
  const ico = (name, size = 20, cls) => sym("ic-" + name, size, "ico " + (cls || ""));
  const FACES = ["neutral", "sniffing", "napping", "nagging", "worried", "grumpy", "victory"];
  const MOOD_LABEL = { sniffing: "Researching", napping: "Waiting for a reply", nagging: "Writing and sending", worried: "Needs you", grumpy: "Not happy about this", victory: "Resolved" };
  const STATUS = { planning: "Planning", awaiting_approval: "Needs your OK", working: "Working", waiting: "Waiting", awaiting_confirmation: "Confirm it's done", resolved: "Resolved", stopped: "Stopped", stalled: "Stalled" };

  const toast = (m) => { const t = document.getElementById("toast"); t.textContent = m; t.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 2400); };
  async function api(path, opts = {}) {
    const r = await fetch(path, { credentials: "same-origin", headers: { "content-type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
    let j = null; try { j = await r.json(); } catch {}
    if (!r.ok) throw new Error((j && j.error) || "Request failed (" + r.status + ")");
    return j;
  }

  let user = null, timer = null, heroTimer = null;
  const clean = () => { clearInterval(timer); clearInterval(heroTimer); };

  async function boot() {
    try { user = (await api("/api/me")).user; } catch { user = null; }
    paintWho();
    window.addEventListener("hashchange", route);
    route();
  }
  function paintWho() {
    $who.textContent = user ? (user.kind === "demo" ? "demo session" : user.email) : "";
    $logout.hidden = !user;
    $logout.textContent = user && user.kind === "real" ? "Sign out" : "Reset demo";
    const si = document.getElementById("signin");
    si.hidden = !!(user && user.kind === "real");
    si.onclick = openSignin;
    $logout.onclick = async () => { await api("/api/auth/logout", { method: "POST" }); user = null; location.hash = "#/"; paintWho(); route(); };
  }
  function openSignin() {
    const dlg = document.getElementById("dlg"), form = document.getElementById("dlgform");
    const name = h("input", { placeholder: "Your first name", autocomplete: "given-name" });
    const email = h("input", { type: "email", placeholder: "you@example.com", required: true, autocomplete: "email" });
    const msg = h("p", { class: "fine" });
    const go = h("button", { class: "btn", type: "submit" }, "Email me a sign-in link");
    form.replaceChildren(h("h3", {}, "Sign in to chase real people"), h("p", { class: "fine" }, "Badger CCs you on everything it sends, so it needs to know your address is really yours. No password."),
      h("label", {}, "Name"), name, h("label", {}, "Email"), email, msg, h("div", { class: "row" }, go, h("button", { class: "btn ghost", type: "button", onclick: () => dlg.close() }, "Close")));
    form.onsubmit = async (e) => {
      e.preventDefault(); go.disabled = true; msg.textContent = "Sending...";
      try { await api("/api/auth/request", { method: "POST", body: { email: email.value, name: name.value } }); msg.textContent = "Sent! Check your inbox (and spam) and click the link."; }
      catch (er) { msg.textContent = er.message; go.disabled = false; }
    };
    dlg.showModal();
  }
  function route() {
    clean();
    const m = /^#\/case\/([0-9a-f-]{36})$/.exec(location.hash);
    if (m) return caseView(m[1]);
    window.scrollTo(0, 0);
    landing();
  }
  async function ensureUser() {
    if (!user) { user = (await api("/api/auth/demo", { method: "POST" })).user; paintWho(); }
  }
  async function startScenario(key, fast, btn) {
    const label = btn && btn.textContent;
    if (btn) { btn.disabled = true; btn.textContent = "Starting..."; }
    try {
      await ensureUser();
      const r = await api("/api/demo/start", { method: "POST", body: { scenario: key } });
      if (fast) await api("/api/cases/" + r.case.id + "/fast-forward", { method: "POST" });
      location.hash = "#/case/" + r.case.id;
    } catch (e) { toast(e.message); if (btn) { btn.disabled = false; btn.textContent = label; } }
  }

  /* ------------------------------ landing ------------------------------ */
  async function landing() {
    $app.replaceChildren();
    const heroFace = h("div", { class: "bigface" });
    const caption = h("div", { class: "facecap" });
    const cycle = ["sniffing", "nagging", "napping", "worried", "victory"];
    let ci = 0;
    const paintFace = () => { const m = cycle[ci++ % cycle.length]; heroFace.replaceChildren(face(m, "100%")); caption.textContent = MOOD_LABEL[m]; };
    paintFace(); heroTimer = setInterval(paintFace, 2400);

    const watch = h("button", { class: "btn big" }, ico("play", 22), "Watch a 60-second demo");
    watch.onclick = () => startScenario("roommate", true, watch);
    const diy = h("a", { class: "btn ghost big", href: "#chat" }, "Chase someone for real");
    diy.onclick = (e) => { e.preventDefault(); document.getElementById("chat").scrollIntoView({ behavior: "smooth" }); };

    $app.append(h("section", { class: "hero" },
      h("div", {},
        h("div", { class: "kicker" }, "the agent that nags so you don't have to"),
        h("h1", {}, "Someone owes you. ", h("em", {}, "Badger"), " will ask."),
        h("p", { class: "lead" }, "A friend with your $64. A gym that won't cancel. A landlord who ghosts. Badger researches your rights, writes each nudge for your approval, sends it from its own inbox, reads the reply, and escalates. You never have to be the annoying one."),
        h("div", { class: "cta" }, watch, diy),
        h("p", { class: "fine" }, "No sign-up. The demo plays a full case against a fictional character. Open source: ", h("a", { href: "https://github.com/elsisiem/badger", target: "_blank", rel: "noopener" }, "github.com/elsisiem/badger"), "."),
      ),
      h("div", { class: "facebox" }, heroFace, caption),
    ));

    // The demo, explained before anyone clicks
    $app.append(h("section", { id: "demo" },
      h("div", { class: "kicker" }, "try it"), h("h2", {}, "A whole case, start to finish"),
      h("div", { class: "steps3" },
        h("div", { class: "s3" }, h("span", { class: "num" }, "1"), h("b", {}, "Pick a story"), h("p", {}, "A flaky roommate or a gym that won't let you cancel. The emails are real; the other side is a fictional character who replies in seconds.")),
        h("div", { class: "s3" }, h("span", { class: "num" }, "2"), h("b", {}, "You stay in charge"), h("p", {}, "Badger writes every message and stops for your OK first. Edit it, send it, or skip it. Nothing goes out behind your back.")),
        h("div", { class: "s3" }, h("span", { class: "num" }, "3"), h("b", {}, "Or fast-forward"), h("p", {}, "Short on time? Fast-forward skips the waiting and approves for you, so you can watch the whole timeline play out in about a minute.")),
      ),
    ));

    const cards = h("div", { class: "cards" });
    $app.append(cards);
    let sc = { scenarios: [], demoClock: { day_seconds: 20 } };
    try { sc = await api("/api/scenarios"); } catch {}
    for (const s of sc.scenarios) {
      const step = h("button", { class: "btn ghost" }, "Play it step by step");
      const fast = h("button", { class: "btn" }, ico("ff", 18), "Fast-forward");
      step.onclick = () => startScenario(s.key, false, step);
      fast.onclick = () => startScenario(s.key, true, fast);
      cards.append(h("div", { class: "scn" },
        h("div", { class: "scn-ico" }, ico(s.icon, 44)),
        h("h3", {}, s.label), h("p", {}, s.blurb),
        h("div", { class: "row" }, step, fast)));
    }
    $app.append(h("p", { class: "fine mono" }, "Sandbox clock: 1 day = " + sc.demoClock.day_seconds + " seconds. Real cases run on a real clock: days between nudges."));

    // How it works under the hood
    $app.append(h("section", {},
      h("div", { class: "kicker" }, "what happens inside"), h("h2", {}, "Five jobs, one agent"),
      h("div", { class: "how" },
        h("div", {}, face("sniffing", 54), h("b", {}, "Research"), "Exa finds the company's policy and your rights, with exact quotes and links."),
        h("div", {}, face("nagging", 54), h("b", {}, "Write and send"), "A few well-spaced nudges that get firmer, never rude. Sent from Badger's own inbox."),
        h("div", {}, face("napping", 54), h("b", {}, "Wait, durably"), "Days can pass. The plan survives restarts. Promises are respected."),
        h("div", {}, face("worried", 54), h("b", {}, "Read the reply"), "Stall, refusal, question, redirect to a web form. Badger adapts, and asks you when it must."),
        h("div", {}, face("victory", 54), h("b", {}, "Close the loop"), "When they say it's sorted, you confirm. Then it's done."),
      ),
    ));

    // Chat intake (assistant-ui)
    const chatWrap = h("div", { class: "chat-wrap" });
    const startBtn = h("button", { class: "btn" }, ico("chat", 22), "Chat with Badger");
    chatWrap.append(h("div", { class: "chat-start" }, face("neutral", 64), h("p", {}, "Describe who owes you what, in your own words. Badger asks only what it needs, then opens the case."), startBtn));
    startBtn.onclick = async () => {
      startBtn.disabled = true;
      try {
        await ensureUser();
        chatWrap.replaceChildren();
        const mount = () => window.BadgerChat.mount(chatWrap, { onOpened: (id) => setTimeout(() => { location.hash = "#/case/" + id; }, 1400) });
        if (window.BadgerChat) mount(); else { const sc2 = document.createElement("script"); sc2.src = "/chat/chat.js"; sc2.onload = mount; document.body.append(sc2); }
      } catch (e) { toast(e.message); startBtn.disabled = false; }
    };
    $app.append(h("section", { id: "chat" }, h("div", { class: "kicker" }, "your turn"), h("h2", {}, "Tell Badger who's ignoring you"),
      h("p", { class: "fine" }, "In a demo session Badger can only chase the two fictional characters. Sign in with your email to chase real people (it always shows you the draft first)."), chatWrap));

    if (user) {
      try {
        const { cases } = await api("/api/cases");
        if (cases.length) $app.append(h("section", {}, h("h2", {}, "Your cases"), h("div", { class: "cards" }, cases.map((c) =>
          h("a", { class: "scn link", href: "#/case/" + c.id }, h("div", { class: "scn-ico" }, face(c.mood, 54)), h("h3", {}, c.title), h("div", {}, h("span", { class: "pill s-" + c.status }, STATUS[c.status] || c.status)), c.pending ? h("b", {}, c.pending + " waiting on you") : null)))));
      } catch {}
    }
  }

  /* ------------------------------ case view ------------------------------ */
  async function caseView(id) {
    $app.replaceChildren(h("p", { class: "fine" }, "Loading..."));
    let last = "", approvalKey = "";
    const draw = async () => {
      let data;
      try { data = await api("/api/cases/" + id); } catch (e) { $app.replaceChildren(h("p", {}, e.message), h("a", { href: "#/" }, "Back")); clearInterval(timer); return; }
      const c = data.case;
      const sig = JSON.stringify([c.updated_at, c.autoplay, data.events.length, data.messages.length, data.actions.map((a) => a.id)]);
      if (sig === last) return;
      last = sig;
      const keep = $app.querySelector(".approve") && data.actions.map((a) => a.id).join() === approvalKey;
      render(data, keep);
      approvalKey = data.actions.map((a) => a.id).join();
    };
    await draw();
    timer = setInterval(draw, 1800);

    function render({ case: c, events, messages, actions }, keepApproval) {
      const closed = ["resolved", "stopped"].includes(c.status);
      const oldApprove = keepApproval ? $app.querySelector(".approve-wrap") : null;
      const left = h("div", {}), right = h("div", {});

      if (oldApprove) left.append(oldApprove); else if (actions.length) left.append(approvalBox(c, actions));
      left.append(h("div", { class: "box" }, h("h3", {}, "What's happening"), h("p", { class: "fine" }, "Newest first."), ...[...events].reverse().map(eventRow)));

      right.append(h("div", { class: "box" }, h("h3", {}, "The plan"),
        c.summary ? h("p", { class: "fine" }, c.summary) : null,
        h("p", { class: "fine" }, ico("lock", 14, "inl"), " = Badger will ask for your OK before this one."),
        ...c.plan.map((s) => h("div", { class: "step " + s.status }, h("span", { class: "n" }, "Day " + s.day), h("span", {}, s.label, s.needs_approval && s.status === "pending" ? ico("lock", 14, "inl") : null)))));

      const r = c.research || {};
      const srcs = [...(r.policies || []).map((p) => [p.claim, p.quote, p.url]), ...(r.clocks || []).map((p) => [p.label + (p.days ? " (" + p.days + " days)" : ""), p.quote, p.url])];
      if (srcs.length) right.append(h("div", { class: "box" }, h("h3", {}, "Sourced facts"), h("p", { class: "fine" }, "Found by Exa. Badger only cites what it can quote."), ...srcs.slice(0, 5).map(([t, q, u]) => h("div", { class: "src" }, h("b", {}, t), h("div", {}, "“" + q.slice(0, 220) + "”"), h("a", { href: u, target: "_blank", rel: "noopener noreferrer" }, new URL(u).hostname)))));

      if (messages.length) right.append(h("div", { class: "box" }, h("h3", {}, "The email thread"), ...messages.map((m) => h("div", { class: "msg " + m.direction }, h("small", {}, (m.direction === "out" ? "Badger to " : "From ") + c.counterparty_name), m.body.replace(/\n--\nSent by Badger[\s\S]*$/, "")))));

      const ff = h("button", { class: "btn" }, ico("ff", 18), "Fast-forward");
      ff.onclick = async () => { ff.disabled = true; try { await api("/api/cases/" + id + "/fast-forward", { method: "POST" }); toast("Fast-forwarding. Watch the timeline."); last = ""; draw(); } catch (e) { toast(e.message); ff.disabled = false; } };
      const head = h("div", { class: "case-head" },
        h("div", { class: "mascot mood-" + c.mood }, face(c.mood, 96)),
        h("div", {}, h("h2", {}, c.title),
          h("div", { class: "pills" }, h("span", { class: "pill s-" + c.status }, STATUS[c.status] || c.status), h("span", { class: "pill" }, MOOD_LABEL[c.mood] || c.mood), h("span", { class: "fine" }, "chasing " + c.counterparty_name + " · " + c.emails_sent + " sent"))),
        h("span", { class: "grow" }),
        h("div", { class: "row" }, c.scenario && !closed && !c.autoplay ? ff : null, !closed ? h("button", { class: "btn ghost sm", onclick: async () => { await api("/api/cases/" + id + "/stop", { method: "POST" }); last = ""; draw(); } }, "Stop this case") : null));

      $app.replaceChildren(h("a", { href: "#/", class: "back" }, "← all cases"), head, c.scenario ? coach(c, actions) : null, stepper(c), h("div", { class: "grid" }, left, right));
      if (c.status === "resolved" && window.__confetti !== c.id) { window.__confetti = c.id; confetti(); }
    }

    function coach(c, actions) {
      let title, text;
      if (c.status === "resolved") { title = "That's the whole loop."; text = "Research, draft, your approval, send, read the reply, follow up, resolve. Badger did the awkward part. Try the other story, or chat your own case from the home page."; }
      else if (c.autoplay) { title = "Fast-forward is on."; text = "Badger is skipping the waiting and approving its own drafts. Watch the steps below light up one by one."; }
      else if (actions.length) { title = "Your turn."; text = "Badger wrote this message and will not send it until you approve. Read it, edit it if you like, then press Approve. Or press Fast-forward and Badger approves for you."; }
      else if (c.status === "planning") { title = "Badger is researching."; text = "It is searching the web for the company's policy and your rights (Exa), then planning a few nudges. This takes about 20 seconds."; }
      else { title = "Waiting on the other side."; text = "The fictional character is writing back. Real cases wait days between nudges; here a day takes 20 seconds. Press Fast-forward to skip ahead."; }
      return h("div", { class: "coach" }, face(c.status === "resolved" ? "victory" : "neutral", 44), h("div", {}, h("b", {}, title), h("span", {}, " " + text), h("span", { class: "fine" }, " Sandbox: fictional counterparty, real emails.")));
    }

    function stepper(c) {
      const steps = c.plan.filter((s) => s.kind !== "final");
      const planned = c.status !== "planning";
      const firstPending = steps.findIndex((s) => s.status === "pending");
      const nodes = [{ label: c.status === "planning" ? "Researching" : "Researched and planned", sub: "Exa + plan", state: planned ? "done" : "active" }];
      steps.forEach((s, i) => {
        const closed = ["resolved", "stopped"].includes(c.status);
        let state = s.status === "done" ? "done" : s.status === "skipped" ? "skip" : (i === firstPending && !closed && planned ? "active" : "todo");
        nodes.push({ label: s.label, sub: "Day " + s.day, state });
      });
      nodes.push({ label: c.status === "resolved" ? "Resolved" : c.status === "awaiting_confirmation" ? "Confirm it's done" : "Resolved?", sub: "the goal", state: c.status === "resolved" ? "done" : c.status === "awaiting_confirmation" ? "active" : "todo" });
      return h("ol", { class: "stepper", "aria-label": "Case progress" }, nodes.map((n, i) => h("li", { class: "st " + n.state }, h("span", { class: "dotc" }, n.state === "done" ? ico("check", 22) : String(i + 1)), h("span", { class: "sl" }, n.label), h("span", { class: "ss" }, n.sub))));
    }

    function eventRow(e) {
      const body = [];
      if (e.body) body.push(h("div", { class: "b" }, e.body.length > 420 ? e.body.slice(0, 420) + "..." : e.body));
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
          box.append(h("h3", {}, ico("check", 22, "inl"), " They say it's sorted"), h("p", {}, a.draft.summary || ""), h("p", { class: "fine" }, "Check that it's really done (money received, cancellation confirmed), then tell Badger."),
            h("div", { class: "row" }, h("button", { class: "btn green", onclick: () => decide("approve") }, "Yes, it's sorted"), h("button", { class: "btn ghost", onclick: () => decide("skip") }, "Not yet")));
        } else if (a.kind === "need_info") {
          const inp = h("input", { placeholder: "Your answer" });
          box.append(h("h3", {}, ico("hand", 22, "inl"), " Badger needs you"), h("p", {}, a.draft.question || ""), inp, h("div", { class: "row" }, h("button", { class: "btn", onclick: () => decide("approve", { answer: inp.value }) }, "Send answer")));
        } else {
          const subj = h("input", { value: a.draft.subject || "" });
          const body = h("textarea", {}); body.value = a.draft.body || "";
          const what = a.kind === "web_form" ? "Badger will fill in their web form in a live browser" : a.kind === "escalate_email" ? "Escalation to " + a.draft.to : "Email to " + c.counterparty_name;
          box.append(h("h3", {}, ico("hand", 22, "inl"), " Your OK needed: " + what), h("p", { class: "fine" }, a.draft.note || "Nothing goes out until you approve. Edit freely."), a.kind === "web_form" ? null : subj, body,
            h("div", { class: "row" }, h("button", { class: "btn", onclick: () => decide("approve", { subject: subj.value, body: body.value }) }, ico("mail", 18), a.kind === "web_form" ? "Approve and fill the form" : "Approve and send"), h("button", { class: "btn ghost", onclick: () => decide("skip") }, "Skip this step")));
        }
        wrap.append(box);
      }
      return wrap;
    }
  }

  function confetti() {
    const box = h("div", { class: "confetti" });
    const colors = ["#f2a93b", "#d4533b", "#1f7a78", "#3f8a52", "#2b2b33"];
    for (let i = 0; i < 46; i++) box.append(h("i", { style: "left:" + Math.random() * 100 + "%;background:" + colors[i % colors.length] + ";animation-delay:" + Math.random() * 0.9 + "s;transform:rotate(" + Math.random() * 360 + "deg);border-radius:" + (i % 3 === 0 ? "50%" : "2px") }));
    document.body.append(box);
    setTimeout(() => box.remove(), 4400);
  }

  boot();
})();
