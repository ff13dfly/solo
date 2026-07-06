import { EntityManager } from './EntityManager';
import { Renderer } from './Renderer';
import { InteractionHandler } from './InteractionHandler';

export class CanvasEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.image = null;
    
    this.em = new EntityManager();
    this.renderer = new Renderer(this.ctx);
    this.handler = new InteractionHandler(this.canvas, this.em, (isFinal) => {
      this.render();
      if (isFinal && this.onLayoutChange) {
        this.onLayoutChange(this.em.fields);
      }
    });

    this.onLayoutChange = null;
  }

  // Getters for proxying main.js access (to keep it compatible)
  get fields() { return this.em.fields; }
  set fields(val) { this.em.fields = val; }
  get activeFieldIds() { return this.em.activeFieldIds; }
  get itemMappings() { return this.em.itemMappings; }
  set itemMappings(val) { this.em.itemMappings = val; }
  get isLocked() { return this.em.isLocked; }
  set isLocked(val) { this.em.isLocked = val; }
  get isDragging() { return this.handler.isDragging; }
  get primaryActiveFieldId() { return this.em.primaryActiveFieldId; }
  set primaryActiveFieldId(val) { this.em.primaryActiveFieldId = val; }

  async loadTemplate(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        this.image = img;
        this.canvas.width = img.width;
        this.canvas.height = img.height;
        this.render();
        resolve();
      };
      img.src = url;
    });
  }

  setFields(fields) {
    this.em.setFields(fields);
    this.render();
  }

  addField(x, y, label) {
    const id = this.em.addField(x, y, label);
    this.render();
    return id;
  }

  removeFieldByMapping(mapping) {
    if (this.em.removeFieldByMapping(mapping)) {
      this.render();
      if (this.onLayoutChange) this.onLayoutChange(this.em.fields);
    }
  }

  render(data = null) {
    this.renderer.render(this.image, this.em, data);
  }

  getItemGroupRect() {
    return this.em.getGroupRect();
  }

  align(type) {
    if (this.em.activeFieldIds.size < 2) return;
    const selectedFields = this.em.fields.filter(f => this.em.activeFieldIds.has(f.id));
    
    switch (type) {
      case 'left':
        const minX = Math.min(...selectedFields.map(f => f.x));
        selectedFields.forEach(f => f.x = minX); break;
      case 'right':
        const maxX = Math.max(...selectedFields.map(f => f.x + f.width));
        selectedFields.forEach(f => f.x = maxX - f.width); break;
      case 'top':
        const minY = Math.min(...selectedFields.map(f => f.y));
        selectedFields.forEach(f => f.y = minY); break;
      case 'bottom':
        const maxY = Math.max(...selectedFields.map(f => f.y + f.height));
        selectedFields.forEach(f => f.y = maxY - f.height); break;
    }

    this.render();
    if (this.onLayoutChange) this.onLayoutChange(this.em.fields);
  }
}
