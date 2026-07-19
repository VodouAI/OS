/**
 * Builder Serializer — convert Drawflow graph to actions.json + SKILL.md
 */
const BuilderSerializer = {

  /** Serialize the current graph into actions.json, SKILL.md, and layout */
  serialize(editor, metadata) {
    const exported = editor.export();
    const nodes = Object.values(exported.drawflow.Home.data);

    // Separate by type
    const sps = nodes.filter(n => n.name === 'sp').sort((a, b) => a.pos_x - b.pos_x);
    const options = nodes.filter(n => n.name === 'option');
    const tools = nodes.filter(n => n.name === 'tool');

    // Build SP ID map (drawflow node id -> sequential actions.json id)
    const spIdMap = {};
    sps.forEach((sp, idx) => { spIdMap[sp.id] = idx + 1; });

    // Find initial_steps (tool nodes before first SP, not connected to any SP)
    const firstSpX = sps.length ? sps[0].pos_x : Infinity;
    const initialTools = tools.filter(t => {
      if (t.pos_x >= firstSpX) return false;
      // Check if connected to any SP input
      for (const inp of Object.values(t.inputs || {})) {
        for (const conn of inp.connections || []) {
          const source = nodes.find(n => String(n.id) === String(conn.node));
          if (source && source.name !== 'tool') return false; // connected to non-tool = not initial
        }
      }
      return true;
    });

    const result = {};

    // Initial steps
    if (initialTools.length) {
      result.initial_steps = initialTools.map(t => this._nodeToStep(t));
    }

    // Stopping points
    result.stopping_points = [];
    for (const sp of sps) {
      const spData = sp.data;

      // Check for text_input type
      if (spData.type === 'text_input') {
        result.stopping_points.push({
          id: spIdMap[sp.id],
          title: spData.title || 'Enter text',
          type: 'text_input',
          capture_as: spData.capture_as || 'INPUT',
          options: {}
        });
        continue;
      }

      // Find connected option nodes
      const connectedOpts = this._getConnectedNodes(sp, nodes, 'option');
      const optionsObj = {};

      connectedOpts.forEach((opt, idx) => {
        const chain = this._traceChain(opt, nodes, spIdMap);
        const vars = { ...(opt.data.vars || {}) };
        // Merge var nodes
        for (const vn of chain.varNodes) {
          Object.assign(vars, vn.data.vars || {});
        }

        const steps = chain.toolNodes.map(t => this._nodeToStep(t, chain.llmNodes));

        const option = {
          label: opt.data.label || `Option ${idx + 1}`,
          vars: Object.keys(vars).length ? vars : {},
          steps
        };

        // goto: from chain tracing (edge to another SP) or from properties panel dropdown
        if (chain.gotoSpId && chain.gotoSpId !== spIdMap[sp.id] + 1) {
          option.goto = chain.gotoSpId;
        } else if (opt.data._goto) {
          // _goto from properties panel stores the drawflow node ID — convert to SP id
          const gotoSpId = spIdMap[opt.data._goto];
          if (gotoSpId && gotoSpId !== spIdMap[sp.id] + 1) {
            option.goto = gotoSpId;
          }
        }

        optionsObj[String(idx + 1)] = option;
      });

      result.stopping_points.push({
        id: spIdMap[sp.id],
        title: spData.title || 'Choose',
        options: optionsObj
      });
    }

    // Generate SKILL.md
    const skillMd = this._generateSkillMd(metadata, result);

    return {
      actions: result,
      skillMd,
      layout: exported
    };
  },

  _nodeToStep(toolNode, llmNodes) {
    const d = toolNode.data;
    const step = {};
    if (d.id) step.id = d.id;
    step.server = d.server || '';
    step.tool = d.tool || '';

    // Check if any LLM node feeds into this tool's args
    const args = { ...(d.args || {}) };
    if (llmNodes) {
      for (const lNode of llmNodes) {
        // Check if LLM node's output connects to this tool
        for (const out of Object.values(lNode.outputs || {})) {
          for (const conn of out.connections || []) {
            if (String(conn.node) === String(toolNode.id)) {
              if (!lNode.data.prompt) continue;

              // Use LLM node's target_arg if specified, otherwise smart-detect
              const targetArg = lNode.data.target_arg;
              if (targetArg && targetArg in args) {
                args[targetArg] = `{{LLM:${lNode.data.prompt}}}`;
              } else if (targetArg) {
                // Target specified but not in args — create it
                args[targetArg] = `{{LLM:${lNode.data.prompt}}}`;
              } else {
                // Auto-detect: prefer thought/topic/message/prompt/content, then first string arg
                const preferredKeys = ['thought', 'topic', 'message', 'prompt', 'content', 'query', 'text'];
                const targetKey = preferredKeys.find(k => k in args)
                  || Object.keys(args).find(k => typeof args[k] === 'string' && !args[k].startsWith('{{LLM:'))
                  || 'topic';
                args[targetKey] = `{{LLM:${lNode.data.prompt}}}`;
              }
            }
          }
        }
      }
    }
    step.args = args;

    if (d.capture && Object.keys(d.capture).length) step.capture = d.capture;
    if (d.loop) step.loop = Number(d.loop);
    if (d.stream_progress) step.stream_progress = true;
    return step;
  },

  _getConnectedNodes(node, allNodes, targetType) {
    const results = [];
    for (const output of Object.values(node.outputs || {})) {
      for (const conn of output.connections || []) {
        const target = allNodes.find(n => String(n.id) === String(conn.node));
        if (target && target.name === targetType) results.push(target);
      }
    }
    return results;
  },

  _traceChain(optionNode, allNodes, spIdMap) {
    const toolNodes = [];
    const varNodes = [];
    const llmNodes = [];
    let gotoSpId = null;
    let currentId = optionNode.id;
    const visited = new Set();

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const node = allNodes.find(n => String(n.id) === String(currentId));
      if (!node) break;

      // Follow output_1
      const out = node.outputs?.output_1;
      if (!out?.connections?.length) break;

      const nextId = out.connections[0].node;
      const next = allNodes.find(n => String(n.id) === String(nextId));
      if (!next) break;

      if (next.name === 'tool') {
        toolNodes.push(next);
        // Check for LLM nodes connected to this tool's inputs
        for (const inp of Object.values(next.inputs || {})) {
          for (const conn of inp.connections || []) {
            const src = allNodes.find(n => String(n.id) === String(conn.node));
            if (src && src.name === 'llm') llmNodes.push(src);
          }
        }
      } else if (next.name === 'var') {
        varNodes.push(next);
      } else if (next.name === 'llm') {
        llmNodes.push(next);
      } else if (next.name === 'sp') {
        gotoSpId = spIdMap[next.id];
        break;
      }
      currentId = nextId;
    }

    return { toolNodes, varNodes, llmNodes, gotoSpId };
  },

  _generateSkillMd(metadata, actions) {
    const name = metadata.name || 'untitled-skill';
    const desc = metadata.description || name;
    const triggers = metadata.triggers || name.replace(/-/g, ' ');
    const servers = new Set();
    const walkSteps = (steps) => {
      for (const s of steps || []) {
        if (s.server && !s.server.startsWith('_')) servers.add(s.server);
      }
    };
    walkSteps(actions.initial_steps);
    for (const sp of actions.stopping_points || []) {
      for (const opt of Object.values(sp.options || {})) {
        walkSteps(opt.steps);
      }
    }

    return `---
name: ${name}
description: ${desc}
version: 1.0.0
required_tools: ${JSON.stringify([...servers])}
---

# ${name}

${desc}

**Triggers:** ${triggers}

<!-- Built with Vodou Visual Workflow Builder -->
`;
  }
};
