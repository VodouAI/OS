/**
 * Builder Canvas — Drawflow initialization, node registration, connection validation, drag-from-palette
 */

// Drawflow (CSS + JS) is loaded only when the skill builder mounts. Keeps
// ~158 KB off every page that never opens the visual builder.
async function ensureDrawflow() {
  if (window.Drawflow) return window.Drawflow;
  await Promise.all([
    lazyStyle('https://cdn.jsdelivr.net/gh/jerosoler/Drawflow@0.0.59/dist/drawflow.min.css'),
    lazyScript('https://cdn.jsdelivr.net/gh/jerosoler/Drawflow@0.0.59/dist/drawflow.min.js'),
  ]);
  return window.Drawflow;
}

const BuilderCanvas = {
  editor: null,
  container: null,

  async init(containerEl) {
    const DF = await ensureDrawflow();
    this.container = containerEl;
    this.editor = new DF(containerEl);
    this.editor.reroute = true;
    this.editor.reroute_fix_curvature = true;
    this.editor.force_first_input = false;
    this.editor.start();

    this._setupConnectionValidation();
    this._setupSelectionEvents();

    return this.editor;
  },

  destroy() {
    if (this.editor) {
      this.editor.clear();
      this.editor = null;
    }
  },

  /** Add a node from a palette drag or click */
  addNode(type, x, y, data) {
    const def = BuilderNodes.types[type];
    if (!def) return null;

    const nodeData = data || JSON.parse(JSON.stringify(def.defaultData));
    const html = def.html(nodeData);
    const id = this.editor.addNode(
      type,
      def.inputs,
      def.outputs,
      x, y,
      `builder-node-${type}`,
      nodeData,
      html
    );
    return id;
  },

  /** Update a node's data and re-render its HTML */
  updateNode(nodeId, newData) {
    const node = this.editor.getNodeFromId(nodeId);
    if (!node) return;
    Object.assign(node.data, newData);
    const def = BuilderNodes.types[node.name];
    if (def) {
      const el = document.querySelector(`#node-${nodeId} .drawflow_content_node`);
      if (el) el.innerHTML = def.html(node.data);
    }
  },

  /** Get all nodes of a specific type */
  getNodesOfType(type) {
    const exported = this.editor.export();
    const nodes = exported.drawflow.Home.data;
    return Object.values(nodes).filter(n => n.name === type);
  },

  /** Get connected nodes from a node's outputs */
  getConnectedFrom(nodeId, outputClass) {
    const node = this.editor.getNodeFromId(nodeId);
    if (!node) return [];
    const results = [];
    for (const [outputKey, output] of Object.entries(node.outputs)) {
      if (outputClass && outputKey !== outputClass) continue;
      for (const conn of output.connections || []) {
        results.push({
          nodeId: conn.node,
          node: this.editor.getNodeFromId(conn.node),
          output: outputKey,
          input: conn.output // drawflow names the target port "output" confusingly
        });
      }
    }
    return results;
  },

  /** Trace a chain of nodes from an output, collecting tools/vars/etc */
  traceChain(startNodeId) {
    const tools = [];
    const varSets = [];
    const llmPrompts = [];
    let terminalSP = null;
    let currentId = startNodeId;
    const visited = new Set();

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const connections = this.getConnectedFrom(currentId, 'output_1');
      if (connections.length === 0) break;

      const next = connections[0];
      const nextNode = next.node;
      if (!nextNode) break;

      if (nextNode.name === 'tool') {
        tools.push(nextNode);
      } else if (nextNode.name === 'var') {
        varSets.push(nextNode);
      } else if (nextNode.name === 'llm') {
        llmPrompts.push(nextNode);
      } else if (nextNode.name === 'sp') {
        terminalSP = nextNode;
        break;
      }
      currentId = next.nodeId;
    }
    return { tools, varSets, llmPrompts, terminalSP };
  },

  /** Connection validation — enforce allowed connections */
  _setupConnectionValidation() {
    this.editor.on('connectionCreated', (info) => {
      const sourceNode = this.editor.getNodeFromId(info.output_id);
      const targetNode = this.editor.getNodeFromId(info.input_id);
      if (!sourceNode || !targetNode) return;

      const allowed = {
        'sp':          ['option', 'textinput'],
        'option':      ['tool', 'var', 'llm', 'sp', 'condition', 'script', 'subworkflow'],
        'tool':        ['tool', 'sp', 'llm', 'condition', 'script'],
        'var':         ['tool', 'sp', 'condition', 'script'],
        'textinput':   ['sp', 'tool', 'condition'],
        'llm':         ['tool'],
        'condition':   ['tool', 'sp', 'option', 'var', 'script', 'subworkflow'],
        'script':      ['tool', 'sp', 'condition', 'var'],
        'subworkflow': ['tool', 'sp', 'condition'],
        'schedule':    ['sp', 'tool', 'script'],
      };

      const sourceType = sourceNode.name;
      const targetType = targetNode.name;

      if (!allowed[sourceType]?.includes(targetType)) {
        // Remove invalid connection on next tick (can't remove during event)
        setTimeout(() => {
          this.editor.removeSingleConnection(info.output_id, info.input_id, info.output_class, info.input_class);
          if (typeof Components !== 'undefined') {
            Components.toast('Invalid connection: ' + sourceType + ' \u2192 ' + targetType, 'error');
          }
        }, 0);
      }
    });
  },

  /** Emit custom events when nodes are selected/deselected */
  _setupSelectionEvents() {
    this.editor.on('nodeSelected', (nodeId) => {
      const event = new CustomEvent('builder:nodeSelected', { detail: { nodeId } });
      document.dispatchEvent(event);
    });

    this.editor.on('nodeUnselected', () => {
      const event = new CustomEvent('builder:nodeDeselected');
      document.dispatchEvent(event);
    });

    this.editor.on('nodeRemoved', (nodeId) => {
      const event = new CustomEvent('builder:nodeRemoved', { detail: { nodeId } });
      document.dispatchEvent(event);
    });
  },

  /** Set up keyboard shortcuts */
  initKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (!this.editor) return;
      // Don't intercept when typing in inputs/textareas
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

      // Delete/Backspace — remove selected node
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const selected = this.editor.node_selected;
        if (selected) {
          const nodeId = selected.id?.replace('node-', '');
          if (nodeId) {
            this.editor.removeNodeId('node-' + nodeId);
            e.preventDefault();
          }
        }
      }

      // Ctrl/Cmd+D — duplicate selected node
      if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
        e.preventDefault();
        const selected = this.editor.node_selected;
        if (selected) {
          const nodeId = selected.id?.replace('node-', '');
          const node = this.editor.getNodeFromId(nodeId);
          if (node) {
            const newData = JSON.parse(JSON.stringify(node.data));
            this.addNode(node.name, node.pos_x + 40, node.pos_y + 40, newData);
          }
        }
      }
    });
  },

  /** Set up palette drag-to-canvas */
  initPaletteDrag(paletteEl) {
    const items = paletteEl.querySelectorAll('.builder-palette-item');
    items.forEach(item => {
      item.setAttribute('draggable', 'true');
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('builder-node-type', item.dataset.type);
      });
    });

    this.container.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    this.container.addEventListener('drop', (e) => {
      e.preventDefault();
      const type = e.dataTransfer.getData('builder-node-type');
      if (!type || !BuilderNodes.types[type]) return;

      // Convert page coords to canvas coords
      const rect = this.container.getBoundingClientRect();
      const zoom = this.editor.zoom;
      const x = (e.clientX - rect.left - this.editor.precanvas.style.transform.match(/translate\(([^,]+)/)?.[1]?.replace('px', '') * 1 || 0) / zoom;
      const y = (e.clientY - rect.top) / zoom;

      this.addNode(type, x, y);
    });
  }
};
