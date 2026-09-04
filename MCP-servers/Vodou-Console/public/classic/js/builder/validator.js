/**
 * Builder Validator — pre-export validation with inline error display
 */
const BuilderValidator = {

  validate(editor) {
    const exported = editor.export();
    const nodes = Object.values(exported.drawflow.Home.data);
    const errors = [];

    // Every SP must have at least one connected option (or be text_input)
    for (const sp of nodes.filter(n => n.name === 'sp')) {
      if (sp.data.type === 'text_input') {
        if (!sp.data.capture_as) {
          errors.push({ nodeId: sp.id, msg: 'Text input needs a capture_as variable name' });
        }
        continue;
      }
      const hasOptions = Object.values(sp.outputs || {}).some(o => o.connections?.length > 0);
      if (!hasOptions) {
        errors.push({ nodeId: sp.id, msg: 'Stopping point has no connected options' });
      }
    }

    // Every Tool Call must have server and tool
    for (const tool of nodes.filter(n => n.name === 'tool')) {
      if (!tool.data.server) errors.push({ nodeId: tool.id, msg: 'Missing server name' });
      if (!tool.data.tool) errors.push({ nodeId: tool.id, msg: 'Missing tool name' });
    }

    // Every Option must have a label
    for (const opt of nodes.filter(n => n.name === 'option')) {
      if (!opt.data.label) errors.push({ nodeId: opt.id, msg: 'Option needs a label' });
    }

    // Text Input must have capture_as
    for (const ti of nodes.filter(n => n.name === 'textinput')) {
      if (!ti.data.capture_as) errors.push({ nodeId: ti.id, msg: 'Text input needs a capture_as variable' });
    }

    // Condition must have variable
    for (const cond of nodes.filter(n => n.name === 'condition')) {
      if (!cond.data.variable) errors.push({ nodeId: cond.id, msg: 'Condition needs a variable to check' });
    }

    // Script must have command
    for (const scr of nodes.filter(n => n.name === 'script')) {
      if (!scr.data.command) errors.push({ nodeId: scr.id, msg: 'Script needs a command' });
    }

    // Sub-workflow must have skill name
    for (const sw of nodes.filter(n => n.name === 'subworkflow')) {
      if (!sw.data.skill_name) errors.push({ nodeId: sw.id, msg: 'Sub-workflow needs a skill selected' });
    }

    // Schedule trigger must have schedule
    for (const sched of nodes.filter(n => n.name === 'schedule')) {
      if (!sched.data.schedule) errors.push({ nodeId: sched.id, msg: 'Schedule trigger needs a schedule value' });
    }

    // No completely disconnected nodes
    for (const node of nodes) {
      const hasInput = Object.values(node.inputs || {}).some(i => i.connections?.length > 0);
      const hasOutput = Object.values(node.outputs || {}).some(o => o.connections?.length > 0);
      if (!hasInput && !hasOutput) {
        errors.push({ nodeId: node.id, msg: 'Node is disconnected from the workflow' });
      }
    }

    // Must have at least one stopping point
    const spCount = nodes.filter(n => n.name === 'sp').length;
    if (spCount === 0 && nodes.length > 0) {
      errors.push({ nodeId: null, msg: 'Workflow needs at least one Stopping Point' });
    }

    return errors;
  },

  /** Show/clear error highlights on nodes */
  highlightErrors(errors) {
    // Clear previous
    document.querySelectorAll('.builder-node-error').forEach(el => {
      el.classList.remove('builder-node-error');
      el.removeAttribute('title');
    });

    for (const err of errors) {
      if (!err.nodeId) continue;
      const el = document.querySelector(`#node-${err.nodeId}`);
      if (el) {
        el.classList.add('builder-node-error');
        el.title = err.msg;
      }
    }
  },

  /** Get a summary badge string */
  summary(editor) {
    const exported = editor.export();
    const nodes = Object.values(exported.drawflow.Home.data);
    const sps = nodes.filter(n => n.name === 'sp').length;
    const tools = nodes.filter(n => n.name === 'tool').length;
    const opts = nodes.filter(n => n.name === 'option').length;
    return `${sps} SP${sps !== 1 ? 's' : ''}, ${opts} options, ${tools} tools`;
  }
};
