/**
 * Federated Category Facade
 * 
 * @why Provides a standardized interface for managing hierarchical data categories.
 *      By delegating to the shared library, we ensure consistent behavior across 
 *      all microservices.
 * @see api/library/category.js
 */

// --- SHARED LOGIC DELEGATION ---

module.exports = require('../../../library/category');
