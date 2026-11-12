"use strict";
var __StripeExtExports = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // .build/manifest.js
  var manifest_exports = {};
  __export(manifest_exports, {
    BUILD_TIME: () => BUILD_TIME,
    default: () => manifest_default
  });
  var BUILD_TIME = "2026-11-12 15:42:02.407827416 +0000 UTC m=+1.820011306";
  var manifest_default = {
    "$schema": "https://stripe.com/stripe-app.schema.json",
    "allowed_redirect_uris": [
      "https://app.pulsearr.com/api/stripe/callback"
    ],
    "distribution_type": "public",
    "icon": "./icon.png",
    "id": "com.pulsearr.analytics",
    "name": "PulseARR",
    "permissions": [
      {
        "permission": "connected_account_read",
        "purpose": "Show the connected account's name and default currency in PulseARR."
      },
      {
        "permission": "customer_read",
        "purpose": "Count active customers and attribute each MRR change to a customer."
      },
      {
        "permission": "subscription_read",
        "purpose": "Work out MRR, upgrades, downgrades and cancellations from subscriptions."
      },
      {
        "permission": "invoice_read",
        "purpose": "Rebuild MRR history and detect unpaid invoices from past invoices."
      },
      {
        "permission": "plan_read",
        "purpose": "Read price amounts and billing intervals to normalize MRR."
      },
      {
        "permission": "product_read",
        "purpose": "Show plan names next to each customer and metric."
      },
      {
        "permission": "coupon_read",
        "purpose": "Lower MRR by the discounts customers receive."
      },
      {
        "permission": "charge_read",
        "purpose": "Show failed payments and refunds in the live feed."
      },
      {
        "permission": "credit_note_read",
        "purpose": "Account for credits issued against invoices."
      },
      {
        "permission": "event_read",
        "purpose": "Keep metrics current as subscriptions and invoices change."
      }
    ],
    "stripe_api_access_type": "oauth",
    "version": "0.0.1"
  };
  return __toCommonJS(manifest_exports);
})();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsibWFuaWZlc3QuanMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEFVVE9HRU5FUkFURUQgLSBETyBOT1QgTU9ESUZZXG5cbi8vIFRpbWVzdGFtcCBjaGFuZ2VzIG9uIGV2ZXJ5IGV4cG9ydCwgZW5zdXJpbmcgdGhlIGRldiBzZXJ2ZXIgZGV0ZWN0cyBhIHJlYnVpbGRcbmV4cG9ydCBjb25zdCBCVUlMRF9USU1FID0gJzIwMjYtMTEtMTIgMTU6NDI6MDIuNDA3ODI3NDE2ICswMDAwIFVUQyBtPSsxLjgyMDAxMTMwNic7XG5cbi8vIEFwcCBtYW5pZmVzdCBcdTIwMTQgY29uc3VtZWQgYnkgdGhlIERhc2hib2FyZCB0byBjb25maWd1cmUgdGhlIGFwcFxuZXhwb3J0IGRlZmF1bHQge1xuICBcIiRzY2hlbWFcIjogXCJodHRwczovL3N0cmlwZS5jb20vc3RyaXBlLWFwcC5zY2hlbWEuanNvblwiLFxuICBcImFsbG93ZWRfcmVkaXJlY3RfdXJpc1wiOiBbXG4gICAgXCJodHRwczovL2FwcC5wdWxzZWFyci5jb20vYXBpL3N0cmlwZS9jYWxsYmFja1wiXG4gIF0sXG4gIFwiZGlzdHJpYnV0aW9uX3R5cGVcIjogXCJwdWJsaWNcIixcbiAgXCJpY29uXCI6IFwiLi9pY29uLnBuZ1wiLFxuICBcImlkXCI6IFwiY29tLnB1bHNlYXJyLmFuYWx5dGljc1wiLFxuICBcIm5hbWVcIjogXCJQdWxzZUFSUlwiLFxuICBcInBlcm1pc3Npb25zXCI6IFtcbiAgICB7XG4gICAgICBcInBlcm1pc3Npb25cIjogXCJjb25uZWN0ZWRfYWNjb3VudF9yZWFkXCIsXG4gICAgICBcInB1cnBvc2VcIjogXCJTaG93IHRoZSBjb25uZWN0ZWQgYWNjb3VudCdzIG5hbWUgYW5kIGRlZmF1bHQgY3VycmVuY3kgaW4gUHVsc2VBUlIuXCJcbiAgICB9LFxuICAgIHtcbiAgICAgIFwicGVybWlzc2lvblwiOiBcImN1c3RvbWVyX3JlYWRcIixcbiAgICAgIFwicHVycG9zZVwiOiBcIkNvdW50IGFjdGl2ZSBjdXN0b21lcnMgYW5kIGF0dHJpYnV0ZSBlYWNoIE1SUiBjaGFuZ2UgdG8gYSBjdXN0b21lci5cIlxuICAgIH0sXG4gICAge1xuICAgICAgXCJwZXJtaXNzaW9uXCI6IFwic3Vic2NyaXB0aW9uX3JlYWRcIixcbiAgICAgIFwicHVycG9zZVwiOiBcIldvcmsgb3V0IE1SUiwgdXBncmFkZXMsIGRvd25ncmFkZXMgYW5kIGNhbmNlbGxhdGlvbnMgZnJvbSBzdWJzY3JpcHRpb25zLlwiXG4gICAgfSxcbiAgICB7XG4gICAgICBcInBlcm1pc3Npb25cIjogXCJpbnZvaWNlX3JlYWRcIixcbiAgICAgIFwicHVycG9zZVwiOiBcIlJlYnVpbGQgTVJSIGhpc3RvcnkgYW5kIGRldGVjdCB1bnBhaWQgaW52b2ljZXMgZnJvbSBwYXN0IGludm9pY2VzLlwiXG4gICAgfSxcbiAgICB7XG4gICAgICBcInBlcm1pc3Npb25cIjogXCJwbGFuX3JlYWRcIixcbiAgICAgIFwicHVycG9zZVwiOiBcIlJlYWQgcHJpY2UgYW1vdW50cyBhbmQgYmlsbGluZyBpbnRlcnZhbHMgdG8gbm9ybWFsaXplIE1SUi5cIlxuICAgIH0sXG4gICAge1xuICAgICAgXCJwZXJtaXNzaW9uXCI6IFwicHJvZHVjdF9yZWFkXCIsXG4gICAgICBcInB1cnBvc2VcIjogXCJTaG93IHBsYW4gbmFtZXMgbmV4dCB0byBlYWNoIGN1c3RvbWVyIGFuZCBtZXRyaWMuXCJcbiAgICB9LFxuICAgIHtcbiAgICAgIFwicGVybWlzc2lvblwiOiBcImNvdXBvbl9yZWFkXCIsXG4gICAgICBcInB1cnBvc2VcIjogXCJMb3dlciBNUlIgYnkgdGhlIGRpc2NvdW50cyBjdXN0b21lcnMgcmVjZWl2ZS5cIlxuICAgIH0sXG4gICAge1xuICAgICAgXCJwZXJtaXNzaW9uXCI6IFwiY2hhcmdlX3JlYWRcIixcbiAgICAgIFwicHVycG9zZVwiOiBcIlNob3cgZmFpbGVkIHBheW1lbnRzIGFuZCByZWZ1bmRzIGluIHRoZSBsaXZlIGZlZWQuXCJcbiAgICB9LFxuICAgIHtcbiAgICAgIFwicGVybWlzc2lvblwiOiBcImNyZWRpdF9ub3RlX3JlYWRcIixcbiAgICAgIFwicHVycG9zZVwiOiBcIkFjY291bnQgZm9yIGNyZWRpdHMgaXNzdWVkIGFnYWluc3QgaW52b2ljZXMuXCJcbiAgICB9LFxuICAgIHtcbiAgICAgIFwicGVybWlzc2lvblwiOiBcImV2ZW50X3JlYWRcIixcbiAgICAgIFwicHVycG9zZVwiOiBcIktlZXAgbWV0cmljcyBjdXJyZW50IGFzIHN1YnNjcmlwdGlvbnMgYW5kIGludm9pY2VzIGNoYW5nZS5cIlxuICAgIH1cbiAgXSxcbiAgXCJzdHJpcGVfYXBpX2FjY2Vzc190eXBlXCI6IFwib2F1dGhcIixcbiAgXCJ2ZXJzaW9uXCI6IFwiMC4wLjFcIlxufTtcbiJdLAogICJtYXBwaW5ncyI6ICI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFHTyxNQUFNLGFBQWE7QUFHMUIsTUFBTyxtQkFBUTtBQUFBLElBQ2IsV0FBVztBQUFBLElBQ1gseUJBQXlCO0FBQUEsTUFDdkI7QUFBQSxJQUNGO0FBQUEsSUFDQSxxQkFBcUI7QUFBQSxJQUNyQixRQUFRO0FBQUEsSUFDUixNQUFNO0FBQUEsSUFDTixRQUFRO0FBQUEsSUFDUixlQUFlO0FBQUEsTUFDYjtBQUFBLFFBQ0UsY0FBYztBQUFBLFFBQ2QsV0FBVztBQUFBLE1BQ2I7QUFBQSxNQUNBO0FBQUEsUUFDRSxjQUFjO0FBQUEsUUFDZCxXQUFXO0FBQUEsTUFDYjtBQUFBLE1BQ0E7QUFBQSxRQUNFLGNBQWM7QUFBQSxRQUNkLFdBQVc7QUFBQSxNQUNiO0FBQUEsTUFDQTtBQUFBLFFBQ0UsY0FBYztBQUFBLFFBQ2QsV0FBVztBQUFBLE1BQ2I7QUFBQSxNQUNBO0FBQUEsUUFDRSxjQUFjO0FBQUEsUUFDZCxXQUFXO0FBQUEsTUFDYjtBQUFBLE1BQ0E7QUFBQSxRQUNFLGNBQWM7QUFBQSxRQUNkLFdBQVc7QUFBQSxNQUNiO0FBQUEsTUFDQTtBQUFBLFFBQ0UsY0FBYztBQUFBLFFBQ2QsV0FBVztBQUFBLE1BQ2I7QUFBQSxNQUNBO0FBQUEsUUFDRSxjQUFjO0FBQUEsUUFDZCxXQUFXO0FBQUEsTUFDYjtBQUFBLE1BQ0E7QUFBQSxRQUNFLGNBQWM7QUFBQSxRQUNkLFdBQVc7QUFBQSxNQUNiO0FBQUEsTUFDQTtBQUFBLFFBQ0UsY0FBYztBQUFBLFFBQ2QsV0FBVztBQUFBLE1BQ2I7QUFBQSxJQUNGO0FBQUEsSUFDQSwwQkFBMEI7QUFBQSxJQUMxQixXQUFXO0FBQUEsRUFDYjsiLAogICJuYW1lcyI6IFtdCn0K
