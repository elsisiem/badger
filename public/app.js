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
    const hash = location.hash;
    document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === (hash.startsWith("#/group") ? "#/groups" : hash.startsWith("#/apps") ? "#/apps" : hash.startsWith("#/case") ? "" : "#/")));
    const m = /^#\/case\/([0-9a-f-]{36})$/.exec(hash);
    if (m) return caseView(m[1]);
    const g = /^#\/group\/([0-9a-f-]{36})$/.exec(hash);
    if (g) return groupPage(g[1]);
    window.scrollTo(0, 0);
    if (hash === "#/groups") return groupsPage();
    if (hash === "#/apps") return appsPage();
    landing();
  }
  const money = (c, cur = "USD") => (cur === "USD" ? "$" : cur + " ") + (c / 100).toFixed(2);
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

    // Rosters: the teacher / coach / landlord use case
    const tdemo = h("button", { class: "btn" }, ico("users", 20), "Try the teacher demo");
    tdemo.onclick = () => startTeacherDemo(tdemo);
    $app.append(h("section", {},
      h("div", { class: "kicker" }, "for people who bill people"), h("h2", {}, "Teach students? Run a club? Rent a room?"),
      h("p", { class: "lead", style: "margin-top:10px" }, "Make a group, log what each person owes, and Badger handles every reminder. Text it \"Sam had a lesson today, $45\" from Telegram, Slack or WhatsApp. It keeps one running balance per person, reminds them kindly, and stops when you mark them paid."),
      h("div", { class: "row" }, tdemo, h("a", { class: "btn ghost", href: "#/apps" }, ico("chat", 18), "Chat apps"), h("a", { class: "btn ghost", href: "#/groups" }, "Rosters"))));

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
      if (srcs.length) right.append(h("div", { class: "box" }, h("h3", {}, "Sourced facts"), h("p", { class: "fine" }, "Found by Exa. Badger only cites what it can quote."), ...srcs.slice(0, 5).map(([t, q, u]) => h("div", { class: "src" }, h("b", {}, t), h("div", {}, "“" + (q.length > 220 ? q.slice(0, 220).trimEnd() + "…" : q) + "”"), h("a", { href: u, target: "_blank", rel: "noopener noreferrer" }, new URL(u).hostname)))));

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


  /* ------------------------------ rosters ------------------------------ */
  const INTRO_ROSTER = h("div", { class: "coach" }, ico("users", 40), h("div", {},
    h("b", {}, "For anyone who owes you regularly."), h("span", {}, " Piano students, tenants, club dues, a team that never submits timesheets. Log what each person owes (\"Sam, lesson, $45\"). Badger reminds them kindly on a schedule, keeps one running balance per person, and stops the moment you mark them paid. You never have to text anyone.")));

  async function startTeacherDemo(btn) {
    const label = btn && btn.textContent;
    if (btn) { btn.disabled = true; btn.textContent = "Setting up..."; }
    try {
      await ensureUser();
      const r = await api("/api/demo/teacher", { method: "POST" });
      location.hash = "#/group/" + r.group.id;
    } catch (e) { toast(e.message); if (btn) { btn.disabled = false; btn.textContent = label; } }
  }

  async function groupsPage() {
    $app.replaceChildren(h("a", { href: "#/", class: "back" }, "← home"), h("h2", { style: "margin-top:10px" }, "Rosters"), INTRO_ROSTER.cloneNode(true));
    const demo = h("button", { class: "btn" }, ico("play", 20), "Try the teacher demo");
    demo.onclick = () => startTeacherDemo(demo);
    if (!user) { $app.append(h("div", { class: "row" }, demo), h("p", { class: "fine" }, "A sandbox teacher with two students whose parents are fictional characters. It plays out in about a minute.")); return; }
    let groups = [];
    try { groups = (await api("/api/groups")).groups; } catch (e) { toast(e.message); }
    const list = h("div", { class: "cards" });
    for (const g of groups) {
      list.append(h("a", { class: "scn link", href: "#/group/" + g.id },
        h("div", { class: "scn-ico" }, ico("users", 40)), h("h3", {}, g.name),
        h("div", {}, h("span", { class: "tag " + (g.owed_cents ? "amber" : "green") }, g.owed_cents ? money(g.owed_cents, g.currency) + " owed" : "all paid up"), " ", h("span", { class: "fine" }, g.members.length + " people" + (g.auto_send ? " · auto-reminders on" : ""))),
        h("p", {}, g.members.slice(0, 5).map((m) => m.name).join(", ") || "No one added yet")));
    }
    $app.append(list);
    if (!groups.length) $app.append(h("div", { class: "row" }, demo));
    $app.append(newGroupForm());
  }

  function newGroupForm() {
    const f = (name, label, attrs = {}, tag = "input") => h("label", {}, label, h(tag, { name, ...attrs }));
    const consent = h("input", { type: "checkbox", name: "consent" });
    const form = h("form", { class: "form box", style: "margin-top:24px" },
      h("h3", {}, "Start a new group"),
      h("div", { class: "two" }, f("name", "Group name", { placeholder: "Piano students", required: true }), f("default_amount", "Usual price per item ($)", { type: "number", step: "0.01", min: "0", placeholder: "40" })),
      f("payment_note", "How do people pay you?", { placeholder: "Venmo @sam, bank transfer, or cash at the next lesson" }),
      h("div", { class: "two" }, f("grace_days", "Wait this many days before the first reminder", { type: "number", min: "0", max: "30", value: "3" }), f("repeat_days", "Days between reminders", { type: "number", min: "1", max: "30", value: "7" })),
      f("roster", "People (optional, one per line: name, email)", { placeholder: "Mia Lee, mrs.lee@example.com\nLeo Ortiz, ortiz.family@example.com" }, "textarea"),
      h("label", { class: "check" }, consent, h("span", {}, "The people in this group expect payment reminders from me. If any are under 18, I used a parent's email. (Badger only contacts people you vouch for, always says it's an AI assistant, and stops if anyone asks.)")),
      h("div", { class: "row" }, h("button", { class: "btn", type: "submit" }, "Create group")));
    form.onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(form).entries());
      try {
        await ensureUser();
        const r = await api("/api/groups", { method: "POST", body: { ...d, consent: consent.checked, default_amount: d.default_amount || null } });
        location.hash = "#/group/" + r.group.id;
      } catch (er) { toast(er.message); }
    };
    return form;
  }

  async function groupPage(id) {
    $app.replaceChildren(h("p", { class: "fine" }, "Loading..."));
    let data;
    try { data = await api("/api/groups/" + id); } catch (e) { $app.replaceChildren(h("p", {}, e.message), h("a", { href: "#/groups" }, "Back")); return; }
    const g0 = data.group;
    const isDemo = data.members.some((m) => (m.email || "").startsWith("piano-parent-"));

    const titleEl = h("h2", {});
    const totalEl = h("span", { class: "tag" });
    const coachEl = h("div", {});
    const tableWrap = h("div", { class: "tblwrap" });
    const chargesEl = h("div", {});
    const picks = h("div", { class: "chk" });
    let pickIds = "";

    // --- log a charge (built once so typing is never interrupted) ---
    const desc = h("input", { value: "Lesson", placeholder: "Lesson" });
    const amt = h("input", { type: "number", step: "0.01", min: "0", placeholder: g0.default_amount_cents ? (g0.default_amount_cents / 100).toFixed(2) : "amount" });
    const date = h("input", { type: "date", value: new Date().toISOString().slice(0, 10) });
    const logBtn = h("button", { class: "btn", type: "submit" }, ico("coin", 18), "Log it");
    const logForm = h("form", { class: "form" },
      h("p", { class: "fine" }, "Who had one? Tick everyone it applies to."), picks,
      h("div", { class: "two" }, h("label", {}, "What was it", desc), h("label", {}, "Amount ($)", amt)),
      h("label", {}, "Date", date), h("div", { class: "row" }, logBtn));
    logForm.onsubmit = async (e) => {
      e.preventDefault();
      const ids = [...picks.querySelectorAll("input:checked")].map((i) => i.value);
      if (!ids.length) return toast("Tick at least one person.");
      logBtn.disabled = true;
      try { await api("/api/groups/" + id + "/charges", { method: "POST", body: { member_ids: ids, description: desc.value, amount: amt.value || null, date: date.value } }); toast("Logged for " + ids.length + (ids.length === 1 ? " person." : " people.")); picks.querySelectorAll("input").forEach((i) => (i.checked = false)); await refresh(); }
      catch (er) { toast(er.message); }
      logBtn.disabled = false;
    };

    // --- settings ---
    const sNote = h("input", { value: g0.payment_note || "" });
    const sGrace = h("input", { type: "number", min: "0", max: "30", value: g0.grace_days });
    const sRepeat = h("input", { type: "number", min: "1", max: "30", value: g0.repeat_days });
    const sMax = h("input", { type: "number", min: "1", max: "4", value: g0.max_reminders });
    const sTone = h("select", {}, ["polite", "firm", "badger"].map((t) => h("option", { value: t, selected: t === g0.tone }, t === "badger" ? "persistent (a bit cheeky)" : t)));
    const sAuto = h("input", { type: "checkbox" }); sAuto.checked = !!g0.auto_send;
    const sSave = h("button", { class: "btn ghost", type: "submit" }, "Save settings");
    const settings = h("form", { class: "form" },
      h("label", {}, "How people pay", sNote),
      h("div", { class: "two" }, h("label", {}, "Days before the first reminder", sGrace), h("label", {}, "Days between reminders", sRepeat)),
      h("div", { class: "two" }, h("label", {}, "Max reminders per person", sMax), h("label", {}, "Tone", sTone)),
      h("label", { class: "toggle" }, sAuto, h("span", {}, h("b", {}, "Send gentle reminders without asking me each time."), h("br", {}), h("span", { class: "fine" }, "A standing OK for this group's routine reminders. Anything firmer, and any change of channel, still asks you first. Off means every reminder waits for your tap."))),
      h("div", { class: "row" }, sSave));
    settings.onsubmit = async (e) => {
      e.preventDefault();
      try { await api("/api/groups/" + id, { method: "PATCH", body: { payment_note: sNote.value, grace_days: +sGrace.value, repeat_days: +sRepeat.value, max_reminders: +sMax.value, tone: sTone.value, auto_send: sAuto.checked } }); toast("Saved."); }
      catch (er) { toast(er.message); }
    };

    // --- add people ---
    const addTxt = h("textarea", { placeholder: "Mia Lee, mrs.lee@example.com\nLeo Ortiz, ortiz.family@example.com" });
    const addForm = h("form", { class: "form" }, h("p", { class: "fine" }, "One per line. For students under 18, use a parent's email so the reminder reaches the person who pays."), addTxt, h("div", { class: "row" }, h("button", { class: "btn ghost", type: "submit" }, "Add people")));
    addForm.onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api("/api/groups/" + id + "/members", { method: "POST", body: { text: addTxt.value } }); addTxt.value = ""; toast("Added " + r.added + (r.skipped.length ? ". Skipped: " + r.skipped.join("; ") : ".")); await refresh(); }
      catch (er) { toast(er.message); }
    };

    const ffBtn = h("button", { class: "btn" }, ico("ff", 18), "Fast-forward the reminders");
    ffBtn.onclick = async () => { ffBtn.disabled = true; try { await api("/api/groups/" + id + "/fast-forward", { method: "POST" }); toast("Fast-forwarding."); } catch (e) { toast(e.message); } setTimeout(() => (ffBtn.disabled = false), 4000); };

    $app.replaceChildren(
      h("a", { href: "#/groups", class: "back" }, "← all rosters"),
      h("div", { class: "case-head" }, h("div", { class: "scn-ico" }, ico("users", 44)), h("div", {}, titleEl, h("div", { class: "pills" }, totalEl)), h("span", { class: "grow" }), isDemo ? ffBtn : null),
      coachEl,
      h("div", { class: "box" }, h("h3", {}, "Who owes what"), tableWrap),
      h("div", { class: "grid" },
        h("div", {}, h("div", { class: "box" }, h("h3", {}, "Log a lesson or charge"), logForm), h("div", { class: "box" }, h("h3", {}, "Recent activity"), chargesEl)),
        h("div", {}, h("div", { class: "box" }, h("h3", {}, "Reminder settings"), settings), h("div", { class: "box" }, h("h3", {}, "Add people"), addForm))));

    async function refresh() {
      let d;
      try { d = await api("/api/groups/" + id); } catch { return; }
      const g = d.group;
      titleEl.textContent = g.name;
      totalEl.className = "tag " + (d.owed_cents ? "amber" : "green");
      totalEl.textContent = d.owed_cents ? money(d.owed_cents, g.currency) + " outstanding" : "everyone is paid up";
      coachEl.replaceChildren(isDemo ? h("div", { class: "coach" }, face(d.owed_cents ? "nagging" : "victory", 44), h("div", {}, h("b", {}, d.owed_cents ? "Badger is on it." : "All clear."), h("span", {}, d.owed_cents ? " Each parent below has an overdue balance, so Badger opened a case and is sending gentle reminders (this roster has auto-reminders on). Open a person's case to watch, or press Fast-forward." : " Every parent paid and Badger stopped. That's the whole loop: you logged the lessons, Badger did the asking."), h("span", { class: "fine" }, " Sandbox: the parents are fictional characters; the emails are real.")))
        : g.consent_at && !d.members.length ? h("div", { class: "coach" }, face("neutral", 44), h("div", {}, h("b", {}, "Next: add your people."), h("span", {}, " Use the box on the right, one per line.")))
        : d.members.some((m) => !m.email) ? h("div", { class: "coach" }, face("worried", 44), h("div", {}, h("b", {}, "Some people have no email yet."), h("span", {}, " Badger can't remind them until you add one (use a parent's email for under-18s).")))
        : null);

      const rows = d.members.map((m) => {
        let status;
        if (m.reminders_paused) status = h("span", { class: "tag grey" }, "reminders paused");
        else if (m.case_id) status = h("a", { href: "#/case/" + m.case_id, class: "tag amber", style: "text-decoration:none" }, "Badger is on it · " + (m.reminders_sent || 0) + " sent");
        else if (m.owed_cents && !m.email) status = h("span", { class: "tag grey" }, "needs an email");
        else if (m.owed_cents) status = h("span", { class: "tag" }, "not overdue yet");
        else status = h("span", { class: "tag green" }, "paid up");
        const acts = h("div", { class: "row", style: "margin:0" });
        if (m.owed_cents) {
          acts.append(h("button", { class: "btn sm green", onclick: async () => { try { await api("/api/members/" + m.id + "/paid", { method: "POST", body: {} }); toast(m.name + " marked paid."); refresh(); } catch (e) { toast(e.message); } } }, "Paid in full"));
          acts.append(h("button", { class: "linkbtn", onclick: async () => { const v = prompt("How much did " + m.name + " pay? (e.g. 20)"); if (!v) return; try { const r = await api("/api/members/" + m.id + "/paid", { method: "POST", body: { amount: v } }); toast("Recorded. " + (r.remaining_cents ? "Still owes " + money(r.remaining_cents, g.currency) : "All paid up.")); refresh(); } catch (e) { toast(e.message); } } }, "part payment"));
        }
        acts.append(h("button", { class: "linkbtn", onclick: async () => { try { await api("/api/members/" + m.id, { method: "PATCH", body: { reminders_paused: !m.reminders_paused } }); refresh(); } catch (e) { toast(e.message); } } }, m.reminders_paused ? "resume reminders" : "pause reminders"));
        return h("tr", {}, h("td", {}, h("b", {}, m.name), m.payer_name ? h("div", { class: "fine", style: "margin:0" }, "pays: " + m.payer_name) : null, h("div", { class: "fine", style: "margin:0" }, m.email || "no email")),
          h("td", { class: "num " + (m.owed_cents ? "owed" : "clear") }, m.owed_cents ? money(m.owed_cents, g.currency) : "—"), h("td", {}, status), h("td", {}, acts));
      });
      tableWrap.replaceChildren(d.members.length ? h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, h("th", {}, "Person"), h("th", { class: "num" }, "Owes"), h("th", {}, "Badger"), h("th", {}, ""))), h("tbody", {}, rows)) : h("p", { class: "fine" }, "No one yet."));

      const key = d.members.map((m) => m.id).join();
      if (key !== pickIds) {
        const checked = new Set([...picks.querySelectorAll("input:checked")].map((i) => i.value));
        picks.replaceChildren(...d.members.map((m) => h("label", {}, h("input", { type: "checkbox", value: m.id, checked: checked.has(m.id) }), m.name)));
        pickIds = key;
      }
      chargesEl.replaceChildren(...(d.charges.length ? d.charges.slice(0, 12).map((c) => h("div", { class: "ev" }, h("span", { class: "dot", style: c.status === "paid" ? "background:var(--green)" : "background:var(--red)" }), h("div", {}, h("div", { class: "t" }, c.member_name + " · " + c.description + " · " + money(c.amount_cents, g.currency)), h("div", { class: "b" }, String(c.incurred_on).slice(0, 10) + " · " + c.status + (c.status === "owed" ? "" : ""))))) : [h("p", { class: "fine" }, "Nothing logged yet.")]));
    }
    await refresh();
    timer = setInterval(refresh, 2500);
  }

  /* ------------------------------ chat apps ------------------------------ */
  const APPS = {
    telegram: { name: "Telegram", blurb: "Message Badger like a friend. Approve drafts with one tap on inline buttons.", setup: "Create a bot with @BotFather, then set TELEGRAM_BOT_TOKEN on the server." },
    slack: { name: "Slack", blurb: "DM the Badger app in your workspace. Great for teams and clubs.", setup: "Create the Slack app from the manifest in the repo, then set SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET." },
    whatsapp: { name: "WhatsApp", blurb: "Text Badger on WhatsApp (via Twilio).", setup: "Set up the Twilio WhatsApp sandbox, then set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_WHATSAPP_FROM." },
  };
  async function appsPage() {
    $app.replaceChildren(h("a", { href: "#/", class: "back" }, "← home"), h("h2", { style: "margin-top:10px" }, "Text Badger from your chat apps"),
      h("p", { class: "lead", style: "margin-top:8px" }, "Log a lesson, check who owes you, or approve a draft without opening this site. Badger also messages you when it needs a decision."),
      h("div", { class: "box" }, h("h3", {}, "Things you can say"), ...["Sam had a lesson today, $45", "Lee paid", "who owes me?", "Add Priya, priya@example.com to Piano students", "APPROVE  (or SKIP)  when Badger asks"].map((t) => h("div", { class: "example" }, t))));
    let info;
    try { await ensureUser(); info = await api("/api/channels"); } catch (e) { $app.append(h("p", {}, e.message)); return; }
    const grid = h("div", { class: "apps" });
    for (const c of info.channels) {
      const meta = APPS[c.channel];
      const card = h("div", { class: "app" }, h("div", { class: "row", style: "margin:0" }, ico("chat", 30), h("h3", {}, meta.name), c.linked.length ? h("span", { class: "tag green" }, "connected") : c.available ? h("span", { class: "tag" }, "ready") : h("span", { class: "tag grey" }, "not set up")), h("p", { class: "fine", style: "margin:0" }, meta.blurb));
      const out = h("div", {});
      if (c.linked.length) {
        out.append(h("p", { class: "fine" }, "Linked as " + c.linked.map((l) => l.label || "this chat").join(", ") + "."), h("button", { class: "btn ghost sm", onclick: async () => { await api("/api/channels/" + c.channel, { method: "DELETE" }); appsPage(); } }, "Disconnect"));
      } else if (c.available) {
        const btn = h("button", { class: "btn" }, ico("plug", 18), "Connect " + meta.name);
        btn.onclick = async () => {
          btn.disabled = true;
          try {
            const r = await api("/api/channels/" + c.channel + "/link-code", { method: "POST" });
            out.replaceChildren(h("div", { class: "codebox" }, r.code), h("p", { class: "fine" }, r.instructions + ". The code works for " + r.expires_in_minutes + " minutes."), r.deep_link ? h("a", { class: "btn", href: r.deep_link, target: "_blank", rel: "noopener" }, "Open Telegram") : null,
              h("p", { class: "fine" }, "Then come back here; this page updates when you're connected."));
            const poll = setInterval(async () => { try { const i2 = await api("/api/channels"); if (i2.channels.find((x) => x.channel === c.channel).linked.length) { clearInterval(poll); appsPage(); } } catch {} }, 2500);
            timer = poll;
          } catch (e) { toast(e.message); btn.disabled = false; }
        };
        out.append(btn);
      } else {
        out.append(h("p", { class: "fine" }, "Not switched on for this server yet. ", meta.setup, " Full steps: "), h("a", { href: "https://github.com/elsisiem/badger/blob/main/docs/CHANNELS.md", target: "_blank", rel: "noopener", class: "fine" }, "docs/CHANNELS.md"));
      }
      card.append(out);
      grid.append(card);
    }
    $app.append(grid);
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
