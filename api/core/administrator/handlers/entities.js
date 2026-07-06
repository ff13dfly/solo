/**
 * Entity Schema Definitions
 *
 * @why administrator manages the single admin account + system settings — no
 *      business entities. The empty declaration keeps the fleet contract
 *      (every service answers `entities`) so the Router/portal introspection
 *      never special-cases this service.
 */
module.exports = {};
