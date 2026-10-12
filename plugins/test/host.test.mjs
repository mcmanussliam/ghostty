import test from "node:test";
import assert from "node:assert/strict";
import { directory, fixture, host } from "./helpers.mjs";

const sample = `export default { async activate(api) {
  console.log('plugin stdout must not corrupt protocol');
  await api.ui.panes.register({id:'pane',title:'Pane',entry:'view.html'});
  await api.commands.register({id:'open',title:'Open pane',async run(e) {
    await api.ui.panes.open('pane',e.contextId,{reveal:true});
    await api.ui.panes.publish('pane',e.contextId,{hello:'👻'});
  }});
  api.on('context.changed', async ({context}, next) => {
    await api.ui.statusBar.set({id:'repo',contextId:context.id,text:context.cwd,command:'open'});
    return next();
  });
  api.on('ui.pane.close',async (e,next) => {
    await api.log('pre-close');
    if(api.plugin.settings.veto) return {cancel:true};
    const result = await next();
    await api.log('post-close');
    return result;
  });
  api.on('command.run',async (e,next) => { await api.log('pre-command'); const r=await next(); await api.log('post-command'); return r; });
}}`;

test("activation preserves the plugin receiver and command registration returns its result", async (t) => {
  const root = await directory(t);
  const plugin = await fixture(
    root,
    "receiver",
    `export default {
    name:'receiver', async activate(api) {
      await api.log(this.name);
      const result = await api.commands.register({id:'test',title:'Test',run(){}});
      await api.log('registered:'+JSON.stringify(result));
    }
  }`,
  );
  const app = await host(t, root, [plugin]);
  assert.ok(app.messages.some((m) => m.message === "receiver"));
  assert.ok(app.messages.some((m) => m.message === "registered:{}"));
});

test("middleware preserves priority, post-hook order, and single-use next", async () => {
  const { Middleware } = await import("../dist/host/hooks.mjs");
  const middleware = new Middleware();
  const calls = [];
  let signal;
  for (const [name, priority] of [
    ["first", 10],
    ["before", -1],
    ["last", 10],
  ]) {
    middleware.on(
      "session.start",
      async (event, next, abort) => {
        signal = abort;
        assert.ok(Object.isFrozen(event));
        calls.push(`pre-${name}`);
        const result = await next();
        calls.push(`post-${name}`);
        return result;
      },
      priority,
    );
  }
  await middleware.dispatch("session.start", {}, async () => {
    calls.push("core");
    return {};
  });
  assert.deepEqual(calls, [
    "pre-before",
    "pre-first",
    "pre-last",
    "core",
    "post-last",
    "post-first",
    "post-before",
  ]);
  assert.equal(signal.aborted, true);
  middleware.on(
    "session.end",
    async (event, next) => {
      await next();
      return next();
    },
    0,
  );
  await assert.rejects(middleware.dispatch("session.end", {}), /only once/);
});

test("native status clicks dispatch commands; hooks surround pane actions; contexts stay separate", async (t) => {
  const root = await directory(t);
  const plugin = await fixture(root, "sample", sample);
  const app = await host(t, root, [plugin]);
  app.context();
  const first = await app.wait(
    (m) => m.type === "snapshot" && m.statuses.length === 1,
  );
  assert.equal(first.statuses[0].text, root);
  assert.equal(first.contextRevision, 1);
  app.context("window-b", "/second", 2, "surface-b");
  await app.wait(
    (m) => m.contextId === "window-b" && m.statuses?.[0]?.text === "/second",
  );
  app.send({
    type: "ui.status.press",
    pluginId: "sample",
    id: "repo",
    contextId: "window-a",
  });
  const opened = await app.wait(
    (m) => m.contextId === "window-a" && m.panes?.[0]?.data?.hello === "👻",
  );
  assert.equal(opened.panes[0].root, plugin.path);
  await app.wait((m) => m.message === "post-command");
  assert.deepEqual(
    app.messages.filter((m) => m.type === "log").map((m) => m.message),
    ["pre-command", "post-command"],
  );
  const mark = app.messages.length;
  app.send({
    type: "ui.pane.close",
    pluginId: "sample",
    id: "pane",
    contextId: "window-a",
  });
  await app.wait((m) => m.message === "post-close", mark);
  await app.wait(
    (m) => m.contextId === "window-a" && m.panes?.length === 0,
    mark,
  );
  app.send({ type: "context.close", contextId: "window-a" });
  await app.wait(
    (m) => m.contextId === "window-a" && m.statuses?.length === 0,
    mark,
  );
});

test("a pre hook can cancel native pane close without running post/core behavior", async (t) => {
  const root = await directory(t);
  const app = await host(t, root, [
    await fixture(root, "sample", sample, { veto: true }),
  ]);
  app.context();
  await app.wait((m) => m.statuses?.length === 1);
  app.send({
    type: "command.run",
    pluginId: "sample",
    id: "open",
    contextId: "window-a",
  });
  await app.wait((m) => m.panes?.length === 1);
  const mark = app.messages.length;
  app.send({
    type: "ui.pane.close",
    pluginId: "sample",
    id: "pane",
    contextId: "window-a",
  });
  await app.wait((m) => m.message === "pre-close", mark);
  // A subsequent command is a barrier: its post hook runs only after the close hook finished.
  app.send({
    type: "command.run",
    pluginId: "sample",
    id: "open",
    contextId: "window-a",
  });
  await app.wait((m) => m.message === "post-command", mark);
  assert.equal(
    app.messages.slice(mark).some((m) => m.message === "post-close"),
    false,
  );
  assert.equal(
    app.messages.slice(mark).some((m) => m.panes?.length === 0),
    false,
  );
});

test("CPU-bound hooks are killed while a healthy plugin continues updating", async (t) => {
  const root = await directory(t);
  const bad = await fixture(
    root,
    "bad",
    `export default { activate(api) { api.on('context.changed',()=>{while(true){}}); } }`,
  );
  const good = await fixture(
    root,
    "good",
    `export default { activate(api) { api.on('context.changed',async ({context},next)=> {
    await api.ui.statusBar.set({id:'alive',contextId:context.id,text:context.cwd});return next();
  }); } }`,
  );
  const app = await host(t, root, [bad, good]);
  app.context();
  await app.wait((m) => m.statuses?.[0]?.pluginId === "good");
  const failure = await app.wait(
    (m) => m.type === "error" && m.pluginId === "bad",
  );
  assert.match(failure.message, /exceeded/);
  const mark = app.messages.length;
  app.context("window-a", "/still-alive", 2);
  await app.wait((m) => m.statuses?.[0]?.text === "/still-alive", mark);
});

test("UI registration confines pane files and errors do not corrupt the supervisor", async (t) => {
  const root = await directory(t);
  const plugin = await fixture(
    root,
    "invalid",
    `export default { async activate(api) {
    try { await api.ui.panes.register({id:'escape',title:'Escape',entry:'../plugins.json'}); }
    catch(e) { await api.log(e.message); }
    api.on('context.changed',async ({context},next)=>{
      await api.ui.statusBar.set({id:'ok',contextId:context.id,text:'still running'}); return next();
    });
  }} `,
  );
  const app = await host(t, root, [plugin]);
  assert.ok(app.messages.some((m) => /escapes/.test(m.message ?? "")));
  app.context();
  await app.wait((m) => m.statuses?.[0]?.text === "still running");
});

test("closing a context invalidates pending API writes and supervisor exits when native stdin closes", async (t) => {
  const root = await directory(t);
  const app = await host(t, root, [await fixture(root, "sample", sample)]);
  app.context();
  await app.wait((m) => m.statuses?.length === 1);
  const mark = app.messages.length;
  app.send({ type: "context.close", contextId: "window-a" });
  await app.wait(
    (m) => m.contextId === "window-a" && m.statuses?.length === 0,
    mark,
  );
  app.child.stdin.end();
  const status = await app.exit;
  assert.equal(status, 0);
});

test("revision guards reject async writes for a previous terminal directory", async (t) => {
  const root = await directory(t);
  const plugin = await fixture(
    root,
    "revisions",
    `export default { activate(api) {
    api.on('context.changed',async ({context},next)=>{
      const result = await api.ui.statusBar.set({id:'repo',contextId:context.id,revision:1,text:'old directory'});
      await api.log(JSON.stringify(result));
      return next();
    });
  }} `,
  );
  const app = await host(t, root, [plugin]);
  app.context();
  await app.wait((m) => m.statuses?.length === 1);
  const mark = app.messages.length;
  app.context("window-a", "/new-directory", 2);
  await app.wait((m) => m.message === '{"stale":true}', mark);
  await app.wait(
    (m) => m.contextRevision === 2 && m.statuses?.length === 0,
    mark,
  );
  assert.equal(
    app.messages
      .slice(mark)
      .some((m) => m.contextRevision === 2 && m.statuses?.length === 1),
    false,
  );
});

test("a delayed native close cannot dismiss a newer directory or focused split", async (t) => {
  for (const transition of ["directory", "split"]) {
    await t.test(transition, async (t) => {
      const root = await directory(t);
      const plugin = await fixture(
        root,
        "delayed",
        `export default {async activate(api) {
        await api.ui.panes.register({id:'pane',title:'Pane',entry:'view.html',retainOnContextChange:true});
        api.on('context.changed', async ({context},next) => {
          await api.ui.panes.open('pane',context.id,{revision:context.revision,data:{revision:context.revision}});
          await api.log('opened-'+context.revision);
          return next();
        });
        api.on('ui.pane.close', async (event,next) => {
          await api.log('closing-'+event.revision);
          await new Promise(resolve => setTimeout(resolve,150));
          const result = await next({id:event.id,contextId:event.contextId});
          await api.log(JSON.stringify(result));
          return result;
        });
      }}`,
      );
      const app = await host(t, root, [plugin]);
      app.context();
      await app.wait((m) => m.panes?.[0]?.data?.revision === 1);
      const mark = app.messages.length;
      app.send({
        type: "ui.pane.close",
        pluginId: "delayed",
        id: "pane",
        contextId: "window-a",
      });
      await app.wait((m) => m.message === "closing-1", mark);
      app.context(
        "window-a",
        transition === "directory" ? "/new" : root,
        2,
        transition === "split" ? "surface-b" : "surface-a",
      );
      await app.wait((m) => m.message === '{"stale":true}', mark);
      await app.wait((m) => m.message === "opened-2", mark);
      await app.wait(
        (m) => m.contextRevision === 2 && m.panes?.[0]?.data?.revision === 2,
        mark,
      );
      assert.ok(
        app.messages
          .slice(mark)
          .filter((m) => m.type === "snapshot")
          .every((m) => m.panes.length === 1),
      );
    });
  }
});

test("manifest capabilities gate the host API", async (t) => {
  const root = await directory(t);
  const plugin = await fixture(
    root,
    "permissions",
    `export default {async activate(api) {
    try { await api.contexts.list(); } catch(e) { await api.log(e.message); }
  }}`,
  );
  const { readFile, writeFile } = await import("node:fs/promises");
  const manifestPath = `${plugin.path}/plugin.json`;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.capabilities = [];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const app = await host(t, root, [plugin]);
  assert.ok(
    app.messages.some((m) => m.message === "Undeclared capability: context"),
  );
});

test("context transitions preserve pane identity, clear stale data, and settle on publish", async (t) => {
  const root = await directory(t);
  const plugin = await fixture(
    root,
    "transition",
    `export default {async activate(api) {
    await api.ui.panes.register({id:'pane',title:'Pane',entry:'view.html',width:280,retainOnContextChange:true});
    await api.ui.panes.register({id:'transient',title:'Transient',entry:'view.html'});
    api.on('context.changed', ({context},next) => {
      void (async () => {
        if(context.revision > 1) await new Promise(resolve => setTimeout(resolve,100));
        await api.ui.panes.open('pane',context.id,{revision:context.revision,data:{cwd:context.cwd}});
        if(context.revision === 1) await api.ui.panes.open('transient',context.id,{data:{initial:true}});
      })();
      return next();
    });
  }}`,
  );
  const app = await host(t, root, [plugin]);
  app.context();
  const initial = await app.wait(
    (m) => m.panes?.[0]?.data?.cwd === root && m.panes.length === 2,
  );
  assert.ok(
    app.messages
      .filter((m) => m.panes?.length)
      .every((m) => m.panes[0].data !== null),
  );
  const mark = app.messages.length;
  app.context("window-a", "/new", 2);
  const loading = await app.wait(
    (m) => m.contextRevision === 2 && m.panes?.[0]?.loading,
    mark,
  );
  assert.equal(loading.panes[0].data, null);
  assert.equal(loading.panes[0].entry, initial.panes[0].entry);
  assert.equal(loading.panes[0].width, 280);
  const settled = await app.wait(
    (m) => m.panes?.[0]?.data?.cwd === "/new",
    mark,
  );
  assert.equal(settled.panes[0].loading, false);
  assert.ok(
    app.messages
      .slice(mark)
      .filter((m) => m.type === "snapshot")
      .every((m) => m.panes.length === 1),
  );
});

test("unchanged UI writes do not schedule snapshots and initial pane data stays bounded", async (t) => {
  const { Supervisor } = await import("../dist/host/supervisor.mjs");
  const supervisor = new Supervisor(() => {});
  supervisor.contexts.set("window", { id: "window", revision: 1 });
  const state = {
    manifest: { id: "test", capabilities: ["ui.panes", "ui.statusBar"] },
    statuses: new Map(),
    panes: new Map([
      [
        "pane",
        {
          id: "pane",
          title: "Pane",
          entry: "/view.html",
          root: "/",
          width: 320,
        },
      ],
    ]),
    commands: new Map(),
    open: new Map(),
    dismissed: new Set(),
  };
  supervisor.plugins.set("test", state);
  let updates = 0;
  supervisor.changed = () => updates++;
  const args = {
    id: "pane",
    contextId: "window",
    revision: 1,
    data: { branch: "main", files: [] },
  };
  await supervisor.api(state, "pane.open", args);
  await supervisor.api(state, "pane.open", {
    ...args,
    data: { files: [], branch: "main" },
  });
  await supervisor.api(state, "pane.publish", args);
  assert.equal(updates, 1);
  const status = { id: "branch", contextId: "window", text: "main" };
  await supervisor.api(state, "status.set", status);
  await supervisor.api(state, "status.set", status);
  assert.equal(updates, 2);
  await supervisor.api(state, "status.remove", {
    id: "absent",
    contextId: "window",
  });
  await supervisor.api(state, "pane.close", {
    id: "absent",
    contextId: "window",
  });
  assert.equal(updates, 2);
  await assert.rejects(
    supervisor.api(state, "pane.open", {
      ...args,
      data: "x".repeat(16 * 1024),
    }),
    /16 KiB/,
  );
  state.open.get("window/pane").loading = true;
  await supervisor.api(state, "pane.publish", args);
  assert.equal(updates, 3);
  assert.equal(state.open.get("window/pane").loading, false);
});
