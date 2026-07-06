/**
 * Rule Engine for Fulfillment
 * @why Decouples business logic from code. Rules are evaluated to decide
 *      if a transition is valid and what side-effects (_tasks) to trigger.
 *
 * The JsonLogic primitives now live in api/library/jsonlogic.js (shared with
 * nexus context assembly). This module re-exports the same surface so existing
 * imports (rules.evaluateCondition / rules.resolveParams) keep working unchanged.
 */
const { evaluateCondition, resolveParams } = require('../../../library/jsonlogic');

module.exports = { evaluateCondition, resolveParams };
