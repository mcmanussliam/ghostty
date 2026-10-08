import {
  definePlugin,
  type PluginAPI,
  type PaneBridge,
} from "../sdk/dist/index.mjs";

export default definePlugin({
  async activate(api: PluginAPI) {
    await api.commands.register({
      id: "show",
      title: "Show",
      run: ({ contextId }) => api.ui.panes.open("pane", contextId),
    });
    await api.ui.panes.register({
      id: "pane",
      title: "Pane",
      entry: "view.html",
      retainOnContextChange: true,
    });
    api.on("context.changed", async ({ context }, next, signal) => {
      if (signal.aborted) return {};
      await api.ui.panes.open("pane", context.id, {
        revision: context.revision,
        data: { cwd: context.cwd },
      });
      await api.ui.statusBar.set({
        id: "cwd",
        contextId: context.id,
        text: context.cwd,
        command: "show",
      });
      return next();
    });
    api.on("ui.pane.close", async (event, next) => {
      const result = await next({ ...event });
      await api.log("Closed");
      return result;
    });
    // @ts-expect-error unknown event names must not compile
    api.on("terminal.magic", () => {});
    await api.ui.statusBar.set({
      id: "bad",
      contextId: "window",
      text: "bad",
      // @ts-expect-error invalid UI alignment must not compile
      alignment: "bottom",
    });
    return () => {};
  },
});

declare const bridge: PaneBridge;
bridge.onState(({ context, data }) => {
  bridge.send({ cwd: context.cwd, data });
});
