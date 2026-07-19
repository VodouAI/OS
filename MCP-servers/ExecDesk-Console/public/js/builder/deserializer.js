/**
 * Builder Deserializer — convert actions.json + optional layout.json back into Drawflow graph
 */
const BuilderDeserializer = {

  /** Load a skill into the editor. Uses layout.json if available, otherwise reconstructs from actions. */
  async load(editor, skillName) {
    try {
      // Try layout first (preserves exact positions)
      const [actions, layout] = await Promise.all([
        API.get(`/api/skills/${encodeURIComponent(skillName)}/actions`),
        API.get(`/api/skills/${encodeURIComponent(skillName)}/layout`).catch(() => null)
      ]);

      if (layout && layout.drawflow) {
        editor.import(layout);
        return { success: true, source: 'layout' };
      }

      // Reconstruct from actions.json
      if (actions && actions.stopping_points) {
        this.fromActions(editor, actions);
        return { success: true, source: 'actions' };
      }

      return { success: false, error: 'No actions found' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  /** Reconstruct graph from actions.json (auto-layout) */
  fromActions(editor, actions) {
    editor.clear();

    const X_START = 80;
    const X_PHASE = 380;
    const Y_START = 60;
    const Y_SPACING = 130;
    const X_OPT_OFFSET = 200;
    const X_TOOL_OFFSET = 180;

    const spNodeIds = {}; // actions SP id -> drawflow node id

    // 1. Initial steps
    if (actions.initial_steps?.length) {
      let y = Y_START;
      let prevId = null;
      for (const step of actions.initial_steps) {
        const id = editor.addNode('tool', 1, 1, X_START, y, 'builder-node-tool',
          this._stepToData(step), BuilderNodes.types.tool.html(this._stepToData(step)));
        if (prevId) {
          editor.addConnection(prevId, id, 'output_1', 'input_1');
        }
        prevId = id;
        y += Y_SPACING;
      }
    }

    // 2. Stopping points
    for (let spIdx = 0; spIdx < actions.stopping_points.length; spIdx++) {
      const sp = actions.stopping_points[spIdx];
      const spX = X_START + 100 + spIdx * X_PHASE;
      const optCount = Math.max(Object.keys(sp.options || {}).length, 1);

      const spData = { title: sp.title || '', type: sp.type || 'menu', capture_as: sp.capture_as || '' };
      const spId = editor.addNode('sp', 1, optCount, spX, Y_START, 'builder-node-sp',
        spData, BuilderNodes.types.sp.html(spData));
      spNodeIds[sp.id] = spId;

      // Text input type
      if (sp.type === 'text_input') {
        const tiData = { prompt: sp.title || '', capture_as: sp.capture_as || '' };
        const tiId = editor.addNode('textinput', 1, 1, spX + X_OPT_OFFSET, Y_START, 'builder-node-textinput',
          tiData, BuilderNodes.types.textinput.html(tiData));
        editor.addConnection(spId, tiId, 'output_1', 'input_1');
        continue;
      }

      // Menu options
      let optY = Y_START;
      let outputIdx = 1;
      for (const [key, opt] of Object.entries(sp.options || {})) {
        const optData = { number: key, label: opt.label || '', vars: opt.vars || {}, _goto: opt.goto ? String(opt.goto) : '' };
        const optId = editor.addNode('option', 1, 1, spX + X_OPT_OFFSET, optY, 'builder-node-option',
          optData, BuilderNodes.types.option.html(optData));
        editor.addConnection(spId, optId, `output_${outputIdx}`, 'input_1');
        outputIdx++;

        // Tool chain
        let prevId = optId;
        let toolX = spX + X_OPT_OFFSET + X_TOOL_OFFSET;
        for (const step of opt.steps || []) {
          const toolData = this._stepToData(step);
          const toolId = editor.addNode('tool', 1, 1, toolX, optY, 'builder-node-tool',
            toolData, BuilderNodes.types.tool.html(toolData));
          editor.addConnection(prevId, toolId, 'output_1', 'input_1');
          prevId = toolId;
          toolX += X_TOOL_OFFSET;
        }

        optY += Y_SPACING;
      }
    }

    // 3. Wire goto connections (second pass — all SP nodes must exist)
    for (const sp of actions.stopping_points) {
      for (const [key, opt] of Object.entries(sp.options || {})) {
        if (opt.goto && spNodeIds[opt.goto]) {
          // Find the last tool in this option's chain, or the option node itself
          // For simplicity, the goto is stored as data on the option node
          // The serializer reads _goto from option data
        }
      }
    }
  },

  _stepToData(step) {
    return {
      id: step.id || '',
      server: step.server || '',
      tool: step.tool || '',
      args: step.args || {},
      capture: step.capture || {},
      loop: step.loop || null,
      stream_progress: step.stream_progress || false
    };
  }
};
