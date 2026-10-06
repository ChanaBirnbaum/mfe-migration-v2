# דו-קיום: שירות מוסב תחת Host ישן ותחת Host חדש

שירות שעבר הסבה רץ בשלושה מצבים, ובכל אחד מהם על גרסת React אחרת. רוב החריגים בהסבה נובעים מזה.

| מצב | מי טוען את השירות | React בפועל | מה רץ |
|---|---|---|---|
| **פיתוח עצמאי** (`webpack serve`, ‏verify-runtime) | השירות עצמו | 18, מ-`node_modules` של השירות | `bootstrap.js` → `createRoot` → `<App />` |
| **Host ישן** (React 17) | ה-Host, דרך `remoteEntry.js` | **17**, של ה-Host | רק הקומפוננטה החשופה ב-`exposes` |
| **Host חדש** (React 18) | ה-Host, דרך `remoteEntry.js` | 18, של ה-Host | רק הקומפוננטה החשופה ב-`exposes` |

## למה React 17 תחת Host ישן

`buildSharedGen1({ pkg, require, role: 'remote' })` מגדיר את `react`, ‏`react-dom`, ‏`react-router` ו-`react-router-dom`:

- `singleton: true` – עותק אחד בכל הדף
- `requiredVersion: '^17.0.0 || ' + הטווח מ-package.json` – גרסה 17 של ה-Host מתקבלת
- `import: false` – השירות **לא** מביא עותק משלו. הוא משתמש במה שה-Host סיפק

לכן תחת Host ישן הקוד של השירות רץ על React 17 ועל גרסת ה-router של ה-Host, גם אם ב-package.json כתוב 18.

`devDependencies` נחשבות לא מוצהרות ב-`buildSharedGen1` – לכן `react` ו-`react-dom` חייבים להיות ב-`dependencies`.

## מה אסור בקוד של השירות

| אסור | למה | זוהה על ידי |
|---|---|---|
| `useId`, `useSyncExternalStore`, `useTransition`, `useDeferredValue`, `useInsertionEffect` | לא קיימים ב-React 17 – קריסה תחת Host ישן | scan.js (`react18Only` → REVIEW) |
| API של react-router שנוסף אחרי 6.0.2 (`createBrowserRouter`, `RouterProvider`, `useOutletContext`, `loader=` …) | ה-Host הישן מספק router 6.0.2 | scan.js (`routerPost602` → REVIEW) |
| `useSyncExternalStore` גם דרך ספרייה | אותה סיבה – ודא שספריות חדשות תומכות ב-React 17 | ידני |

## מה כן בטוח

- **`createRoot` ב-`bootstrap.js`.** ה-Host טוען רק את מה שב-`exposes`, ו-`exposes` חושף קומפוננטה ולא את bootstrap.
  `react-dom/client` רץ רק בפיתוח עצמאי, שבו React הוא 18.
- **MUI v7, ‏Emotion 11, ‏react-router-dom 6.30** – כולם מצהירים על תמיכה ב-React 17 ומעלה.
- **Automatic batching ו-StrictMode כפול** – קיימים רק ב-18. קוד שעובד ב-18 עובד גם ב-17 מהבחינה הזו.
  ה-cancelled guard של codemod-anti-patterns נועד ל-StrictMode, ואינו מזיק ב-17.

## כש-verify-runtime מפנה לכאן

| הודעה | משמעות | מה לעשות |
|---|---|---|
| `React 17.x ולא 18` | `node_modules` עדיין מכיל React 17 – ההתקנה לא רצה או השתמשה ב-lock ישן | הרץ שוב את install (`--from install`) |
| `react-dom/client אינו זמין` | ‏react-dom 17 מותקן | כנ"ל |
| `react ו-react-dom בגרסאות שונות` | התקנה חלקית או תלות שמושכת גרסה אחרת | בדוק `npm ls react react-dom` |

verify-runtime בודק **רק** את מצב הפיתוח העצמאי. הוא לא מעיד על ההתנהגות תחת Host.
לכן ב-checklist של הדוח תמיד מופיעה בדיקה ידנית תחת שני ה-Hosts.
