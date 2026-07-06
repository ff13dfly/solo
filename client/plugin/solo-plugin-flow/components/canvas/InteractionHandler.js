/**
 * Interaction Handler: Manages mouse events and orchestration
 */
export class InteractionHandler {
  constructor(canvas, entityManager, onUpdate) {
    this.canvas = canvas;
    this.em = entityManager;
    this.onUpdate = onUpdate; // Callback to trigger re-render

    this.isDragging = false;
    this.dragOffsets = new Map();

    this.bindEvents();
  }

  bindEvents() {
    this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
    window.addEventListener('mousemove', this.handleMouseMove.bind(this));
    window.addEventListener('mouseup', this.handleMouseUp.bind(this));
  }

  getMousePos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (this.canvas.width / rect.width),
      y: (e.clientY - rect.top) * (this.canvas.height / rect.height)
    };
  }

  handleMouseDown(e) {
    if (this.em.isLocked) return;
    const { x, y } = this.getMousePos(e);

    const fieldIndex = [...this.em.fields].reverse().findIndex(f => 
      x >= f.x && x <= f.x + f.width && 
      y >= f.y && y <= f.y + f.height
    );
    // Reverse because we draw top items last, so they are first to hit
    const actualIndex = fieldIndex === -1 ? -1 : this.em.fields.length - 1 - fieldIndex;

    const groupRect = this.em.getGroupRect();
    const inGroupRect = groupRect && 
      x >= groupRect.x && x <= groupRect.x + groupRect.width &&
      y >= groupRect.y - 25 && y <= groupRect.y + groupRect.height; 

    if (actualIndex !== -1) {
      const field = this.em.fields[actualIndex];
      this.em.primaryActiveFieldId = field.id;

      if (!(e.ctrlKey || e.metaKey)) {
        if (!this.em.activeFieldIds.has(field.id)) {
          this.em.activeFieldIds.clear();
          this.em.activeFieldIds.add(field.id);
        }
      } else {
        if (this.em.activeFieldIds.has(field.id)) this.em.activeFieldIds.delete(field.id);
        else this.em.activeFieldIds.add(field.id);
      }

      this.startDrag(x, y);
      this.em.moveToTop(this.em.activeFieldIds);
    } else if (inGroupRect) {
      // Group Selection
      if (!(e.ctrlKey || e.metaKey)) this.em.activeFieldIds.clear();
      const items = this.em.fields.filter(f => this.em.itemMappings.has(f.mapping));
      items.forEach(f => this.em.activeFieldIds.add(f.id));
      this.em.primaryActiveFieldId = items[0]?.id || null;
      this.startDrag(x, y);
    } else {
      if (!(e.ctrlKey || e.metaKey)) this.em.activeFieldIds.clear();
      this.em.primaryActiveFieldId = null;
    }

    this.onUpdate();
    window.dispatchEvent(new CustomEvent('selection-change', { detail: Array.from(this.em.activeFieldIds) }));
  }

  startDrag(x, y) {
    this.isDragging = true;
    window.dispatchEvent(new CustomEvent('drag-state-change', { detail: true }));
    this.dragOffsets.clear();
    this.em.activeFieldIds.forEach(id => {
      const f = this.em.fields.find(f => f.id === id);
      if (f) this.dragOffsets.set(id, { x: x - f.x, y: y - f.y });
    });
  }

  handleMouseMove(e) {
    if (!this.isDragging || this.em.activeFieldIds.size === 0) return;
    const { x, y } = this.getMousePos(e);

    this.em.activeFieldIds.forEach(id => {
      const field = this.em.fields.find(f => f.id === id);
      const offset = this.dragOffsets.get(id);
      if (field && offset) {
        field.x = x - offset.x;
        field.y = y - offset.y;
      }
    });
    this.onUpdate();
  }

  handleMouseUp() {
    if (this.isDragging) {
      this.isDragging = false;
      window.dispatchEvent(new CustomEvent('drag-state-change', { detail: false }));
      this.onUpdate(true); // Trigger layout change callback
    }
  }
}
