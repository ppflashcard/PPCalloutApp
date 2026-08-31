# PP Callout App

Salesforce REST API callout explorer with **3-pane callout chaining**.

Live demo: [pp-callout-app.vercel.app](https://pp-callout-app.vercel.app)

## Local development

```bash
cd salesforce-callout
npm install
npm run dev
```

Open http://localhost:3000

## Deploy to Vercel

1. Import [github.com/ppflashcard/PPCalloutApp](https://github.com/ppflashcard/PPCalloutApp) in [Vercel](https://vercel.com).
2. Set **Root Directory** to `salesforce-callout`.
3. Deploy — Vercel uses `vercel.json` (`npm run build` + serverless API).
4. In your Salesforce Connected App, add this callback URL:

   ```text
   https://pp-callout-app.vercel.app/api/oauth/callback
   ```

## Login methods

| Tab | Use when |
|-----|----------|
| **SSO Login** | Interactive login (popup); tokens auto-refresh |
| **Username & Password** | SOAP or OAuth password flow |
| **JWT Login** | Server-to-server with certificate |
| **Session ID** | Manual sid from DevTools |

## Environment variables (optional)

Copy `salesforce-callout/.env.example` — never commit `.env`.
