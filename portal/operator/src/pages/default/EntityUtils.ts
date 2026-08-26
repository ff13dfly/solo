export function prepareEntityForCreation(entityDef: any) {
  const systemFields = ['id', 'createdAt', 'updatedAt', 'deletedAt', 'status'];
  const data: any = {};
  
  if (entityDef?.fields) {
    Object.entries(entityDef.fields).forEach(([fieldName, fieldDef]: [string, any]) => {
      if (!systemFields.includes(fieldName)) {
        // Add default empty values based on type
        if (fieldDef.type === 'number') data[fieldName] = 0;
        else if (fieldDef.type === 'boolean') data[fieldName] = false;
        else if (fieldDef.type === 'object') data[fieldName] = {};
        else if (fieldDef.type === 'array') data[fieldName] = [];
        else data[fieldName] = "";
      }
    });
  }

  return data;
}

/**
 * @param authoritative  true only when `item` is a COMPLETE record (fetched via the
 *   entity's `.get`). List rows are NOT complete: services legitimately strip heavy
 *   fields from `list` (a 50-row page of multi-hundred-KB payloads is a 10MB response),
 *   so on a list row "field absent" means "not returned this time", NOT "empty".
 *   Fabricating placeholders for those fields shows the operator an empty record that
 *   isn't, and — worse — a Save would submit the fabricated emptiness back. Placeholders
 *   are therefore only added when the base record is authoritative (where absent truly
 *   means unset). See docs/feedback/done/operator-generic-page-fabricates-empty-fields.md.
 */
export function prepareEntityForEditing(item: any, entityDef: any, authoritative = false) {
  // 1. Filter out system/internal fields to reduce noise
  const systemFields = ['id', 'createdAt', 'updatedAt', 'deletedAt', 'status'];
  const editableData: any = {};
  
  // 2. Pre-fill with existing data (excluding system fields)
  Object.keys(item).forEach(key => {
    if (!systemFields.includes(key)) {
      editableData[key] = item[key];
    }
  });

  // 3. Proactively add missing fields from the entity definition as placeholders —
  //    but only when the record is authoritative (see @param above).
  if (authoritative && entityDef?.fields) {
    Object.entries(entityDef.fields).forEach(([fieldName, fieldDef]: [string, any]) => {
      if (!systemFields.includes(fieldName) && editableData[fieldName] === undefined) {
        // Add default empty values based on type
        if (fieldDef.type === 'number') editableData[fieldName] = 0;
        else if (fieldDef.type === 'boolean') editableData[fieldName] = false;
        else if (fieldDef.type === 'object') editableData[fieldName] = {};
        else if (fieldDef.type === 'array') editableData[fieldName] = [];
        else editableData[fieldName] = "";
      }
    });
  }

  return editableData;
}
