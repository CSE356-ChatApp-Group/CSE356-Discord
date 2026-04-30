/**
 * Bounded structured fields for correlating Redis fanout with WS dispatch logs.
 */

"use strict";

const { wsDeliveryTopicPrefixForMetrics } = require("../websocket/outboundPayload");

/** `delivery_path` — coarse lifecycle bucket (bounded cardinality). */
function deliveryPathLabel(path) {
  if (path === "replay") return "replay";
  if (path === "async_job" || path === "async_enqueue") return "async_job";
  if (path === "fallback") return "fallback";
  return "inline";
}

function wsDispatchFields(logicalChannel, overrides = {}) {
  return {
    delivery_target_kind: wsDeliveryTopicPrefixForMetrics(logicalChannel),
    ...overrides,
  };
}

module.exports = {
  deliveryPathLabel,
  wsDispatchFields,
};
