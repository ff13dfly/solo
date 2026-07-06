/**
 * Renderer: Pure Canvas Drawing Logic
 */
export class Renderer {
  constructor(ctx) {
    this.ctx = ctx;
    this.mappingHints = {
      '存货编码': '__EMPTY_1',
      '存货': '__EMPTY_5',
      '合同号': '__EMPTY_3',
      '业务员名字': '__EMPTY_18',
      '中文名称': '__EMPTY_10',
      '存货名称': '__EMPTY_10',
      '中包规格': '__EMPTY_22',
      '数量': '__EMPTY_25',
      '金额': '__EMPTY_30',
      '单价': '__EMPTY_29',
      '总体积': '__EMPTY_32',
      '单据日期': '__EMPTY_14',
      '创建时间': '__EMPTY_14'
    };
  }

  render(image, entityManager, data = null) {
    if (!image) return;
    const { ctx } = this;
    const { fields, activeFieldIds, primaryActiveFieldId, itemMappings } = entityManager;
    const canvas = ctx.canvas;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    const groupRect = entityManager.getGroupRect();
    const showGroupEffects = entityManager.isItemSelected();

    // 1. Draw Group Background (Only in Edit Mode)
    if (!data && groupRect && showGroupEffects) {
      this.drawGroupRect(groupRect);
    }

    // 2. Separated rendering for Common/Summary vs Item Fields
    const commonFields = fields.filter(f => !itemMappings.has(f.mapping));
    const itemFields = fields.filter(f => itemMappings.has(f.mapping));

    // Render Common Fields (Always once)
    commonFields.forEach(field => {
      this.drawField(field, activeFieldIds.has(field.id), field.id === primaryActiveFieldId, false, showGroupEffects, data, 0);
    });

    // Render Item Fields (Loop if data exists)
    if (data && data.items && data.items.length > 0) {
      // Limit to max rows to avoid overflow (e.g., 15 rows)
      const maxRows = 20;
      data.items.slice(0, maxRows).forEach((item, rowIndex) => {
        const offset = rowIndex * entityManager.rowHeight;
        itemFields.forEach(field => {
          this.drawField(field, false, false, true, false, item, offset, data.summary);
        });
      });
    } else {
      // Edit Mode or No Data
      itemFields.forEach(field => {
        this.drawField(field, activeFieldIds.has(field.id), field.id === primaryActiveFieldId, true, showGroupEffects, null, 0);
      });
    }
  }

  drawGroupRect(rect) {
    const { ctx } = this;
    // Background
    ctx.fillStyle = 'rgba(0, 195, 255, 0.05)';
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    // Border
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(0, 195, 255, 0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    ctx.setLineDash([]);
    // Label
    ctx.fillStyle = 'rgba(0, 195, 255, 0.8)';
    ctx.font = 'bold 14px "JetBrains Mono", monospace';
    ctx.fillText('ITEM GROUP', rect.x + 5, rect.y - 10);
  }

  drawField(field, isActive, isPrimary, isItem, showGroupEffects, data, yOffset, summaryData = null) {
    const { ctx } = this;
    const displayText = this.getDisplayText(field, data, summaryData);
    const drawX = field.x;
    const drawY = field.y + yOffset;

    // Use a flag to check if we are in "Preview Mode" (data is not null and not a template label)
    const isPreview = !!data;

    if (!isPreview) {
      // Edit Mode Visuals
      const activeColor = isItem ? '#00ff7f' : '#00f2ff';
      const normalColor = (isItem && showGroupEffects) ? 'rgba(0, 255, 127, 0.15)' : '#ffff00';

      ctx.strokeStyle = isActive ? activeColor : ((isItem && showGroupEffects) ? 'rgba(0, 255, 127, 0.4)' : 'rgba(0, 195, 255, 0.6)');
      ctx.lineWidth = isPrimary ? 3 : (isActive ? 2 : 1.5);
      ctx.setLineDash([]);
      ctx.strokeRect(drawX, drawY, field.width, field.height);

      ctx.fillStyle = isActive ? activeColor : normalColor;
      ctx.fillRect(drawX, drawY, field.width, field.height);
    }

    // Text (Always Black & Centered)
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 12px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(displayText), drawX + 5, drawY + field.height / 2, field.width - 10);
  }

  getDisplayText(field, data, summaryData) {
    if (!data) return field.mapping || field.label;

    // In multi-item mode, 'data' passed here is either 'activeRow' (for common fields) 
    // or an individual 'item' (for item fields).
    
    // 1. Try direct mapping in the provided object
    if (data[field.mapping] !== undefined) return data[field.mapping];
    
    // 2. Try hints
    const hint = this.mappingHints[field.mapping];
    if (hint && data[hint] !== undefined) return data[hint];

    // 3. Fallback handle for common/summary if data is a row group
    if (data.common && data.common[field.mapping] !== undefined) return data.common[field.mapping];
    if (data.summary && data.summary[field.mapping] !== undefined) return data.summary[field.mapping];
    
    // 4. Handle summary if specifically passed (for item rendering loop)
    if (summaryData && summaryData[field.mapping] !== undefined) return summaryData[field.mapping];

    return '';
  }
}
