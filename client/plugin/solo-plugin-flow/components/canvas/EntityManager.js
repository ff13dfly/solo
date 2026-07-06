/**
 * Entity Manager: Responsible for State, Fields, and Bounds calculation
 */
export class EntityManager {
  constructor() {
    this.fields = []; // { id, label, x, y, width, height, mapping }
    this.activeFieldIds = new Set();
    this.primaryActiveFieldId = null;
    this.itemMappings = new Set();
    this.isLocked = false;
    this.rowHeight = 35; // Default height for repeating rows
  }

  setFields(fields) {
    this.fields = fields.map(f => ({
      id: f.id || Date.now().toString() + Math.random(),
      label: f.label || f.mapping,
      x: f.x,
      y: f.y,
      width: f.width || 120,
      height: f.height || 30,
      mapping: f.mapping || ''
    }));
  }

  addField(x, y, label = "New Field") {
    const id = Date.now().toString() + Math.random();
    this.fields.push({
      id,
      label,
      x: x || 50,
      y: y || 50,
      width: 120,
      height: 30,
      mapping: ''
    });
    return id;
  }

  removeFieldByMapping(mapping) {
    const field = this.fields.find(f => f.mapping === mapping);
    if (field) {
      this.activeFieldIds.delete(field.id);
      this.fields = this.fields.filter(f => f.id !== field.id);
      if (this.primaryActiveFieldId === field.id) this.primaryActiveFieldId = null;
      return true;
    }
    return false;
  }

  getGroupRect() {
    const itemFields = this.fields.filter(f => this.itemMappings.has(f.mapping));
    if (itemFields.length === 0) return null;

    const padding = 10;
    const minX = Math.min(...itemFields.map(f => f.x)) - padding;
    const minY = Math.min(...itemFields.map(f => f.y)) - padding;
    const maxX = Math.max(...itemFields.map(f => f.x + f.width)) + padding;
    const maxY = Math.max(...itemFields.map(f => f.y + f.height)) + padding;

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  isItemSelected() {
    return this.fields.some(f => this.activeFieldIds.has(f.id) && this.itemMappings.has(f.mapping));
  }

  moveToTop(ids) {
    const selected = this.fields.filter(f => ids.has(f.id));
    const unselected = this.fields.filter(f => !ids.has(f.id));
    this.fields = [...unselected, ...selected];
  }
}
