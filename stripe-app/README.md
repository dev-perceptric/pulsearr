# PulseARR Stripe App

The Stripe App teams install to connect their Stripe to PulseARR with read-only access (docs/m1-plan.md section 1). It has no screens inside Stripe: it only grants PulseARR the read permissions in `stripe-app.json`.

## Upload (once, from the Stripe account the other apps use)

```bash
stripe login
stripe plugin install apps
cd stripe-app && stripe apps upload
```

Then in the Stripe Dashboard, open the app:

1. **External test** tab: turn on "Anyone with the link". Up to 25 accounts can install before review.
2. Copy the client id (`ca_…`, inside any install link) into `STRIPE_APP_CLIENT_ID` for `pulsearr-web`. Until the app is published, also set `STRIPE_APP_TEST_LINK` to the `chnlink_…` part of the External test install link; clear it once the app is live.
3. **Webhooks:** Developers → Webhooks → Add destination → "Connected and v2 accounts", URL `https://app.pulsearr.com/api/stripe/webhook`, events: `customer.*`, `customer.subscription.*`, `invoice.*`, `charge.failed`, `charge.refunded`, `price.*`, `product.*`, `coupon.*`, `credit_note.*`, and `account.application.deauthorized` (an uninstall marks the source disconnected). Put its signing secret into `STRIPE_CONNECT_WEBHOOK_SECRET` for `pulsearr-web`.
4. `STRIPE_SECRET_KEY` (the account's live secret key) goes into `pulsearr-web` and `pulsearr-worker`. It trades install codes for tokens and refreshes them.
5. Submit for review (about 4 business days) to get the public install link.

After changing `stripe-app.json`, raise `version` and upload again.
