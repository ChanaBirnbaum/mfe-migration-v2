# scripts/

16 סקריפטים: המתזמר `run.js` ו-15 סקריפטי צינור. כולם רצים עם **cwd = שורש הריפו של השירות** וקוראים את
`reference/` ו-`assets/` דרך הנתיב של הסקיל עצמו (`__dirname`), כך שהם עובדים מכל מיקום התקנה.

## החוזה (כל הסקריפטים)

- השורה האחרונה בפלט: `RESULT: OK | REVIEW | BLOCKED | NOOP`. ל-`run.js` ערכים משלו: `OK | PAUSE | PAUSE_FOR_FIX | FAILED | NOOP`
- קוד יציאה 0 לכל תוצאה צפויה, כולל BLOCKED. קוד 1 רק לקריסה לא צפויה
- כל הפלט ל-stdout. stderr רק בקריסה
- `--json` – אובייקט `{ script, result, changes[], manual[], blockers[], notes[] }` במקום טקסט
- `--dry-run` – אותו נתיב קוד, בלי כתיבה לדיסק
- הרצה שנייה על שירות שכבר טופל → NOOP (חריג: `install.js`)

המפרט המלא: `specs/02-ai-spec (1).md`.

## סדר הצינור

| # | שלב ב-run.js | סקריפט | מה הוא עושה | דגלים נוספים | כותב לשירות |
|---|---|---|---|---|---|
| 1 | preflight | `preflight.js` | בדיקות סביבה: git נקי, Node, registry, גרסאות היעד זמינות, `origin/digital_V2` | – | – (קריאה בלבד) |
| 2 | scan | `scan.js` | מלאי מלא של השירות. deny-list → BLOCKED, ‏API של React 18 / router חדש → REVIEW | `--out <נתיב>` | `.migration/inventory.json` |
| 3 | branch | `branch.js` | בראנץ' עבודה מ-`digital_V2` מעודכן + tag לשחזור. **נקודת אישור** | `--source`, `--target` | בראנץ' + tag |
| 4 | package-json | `package-json.js` | גרסאות היעד, עריכה נקודתית שמשמרת פורמט. pickers → review | `--inventory <נתיב>` | `package.json` |
| 5 | codemod-mui-imports | `codemod-mui-imports.js` | `@material-ui/*` → `@mui/*`, שינויי שמות, `palette.type` | – | `src/**` |
| 6 | codemod-react18 | `codemod-react18.js` | `createRoot` ב-bootstrap, ‏`defaultProps`, ‏`FC` + children | – | `src/**` |
| 7 | codemod-anti-patterns | `codemod-anti-patterns.js` | `useEffect(async …)` → פונקציה פנימית + cancelled guard | `--no-cancel-guard` | `src/**` |
| 8 | commit-mechanical | `commit.js --step mechanical` | commit לשלבים 4–7 | – | commit |
| 9 | codemod-makestyles | `codemod-makestyles.js` | `makeStyles` → אובייקט סגנונות דרך `sx` / `slotProps` | – | `src/**` |
| 10 | use-shared-state | `use-shared-state.js` | מתקין את `assets/useSharedState.v<גרסה>.js` (גרסה מ-`reference/versions.json`, sha256 מאומת מול `assets/useSharedState.meta.json`) ובודק את ה-call-sites | – | `src/**`, גיבוי ב-`.migration/backup/` |
| 11 | webpack-shared | `webpack-shared.js` | `shared` → `buildSharedGen1({ pkg, require, role })` | – | `webpack.config.js` |
| 12 | commit-infra | `commit.js --step infra` | commit לשלבים 9–11 | – | commit |
| 13 | install | `install.js` | מוחק `node_modules` ו-`package-lock.json`, ‏`npm install` נקי. לעולם לא `--legacy-peer-deps` / `--force` | `--timeout` | `node_modules`, `package-lock.json` |
| 14 | webpack-validate | `webpack-shared.js --validate-only` | טוען ומריץ את `webpack.config.js` – מאמת את `buildSharedGen1` אחרי ההתקנה | – | – |
| 15 | build | `build.js` | `npm run build:dev` + פירוק השגיאות ל-diagnostics. **סבב תיקון** | `--command`, `--timeout` | `.migration/build-<n>.json` |
| 16 | verify-runtime | `verify-runtime.js` | `webpack serve --mode development --env sviva=local` (בלי דפדפן), בודק `remoteEntry.js` ו-`/` | `--port`, `--timeout` | – |
| 17 | commit-build-fixes | `commit.js --step build-fixes` | commit לתיקוני ה-build | – | commit |
| 18 | report | `report.js` | `MIGRATION-V2-REPORT.md` מכל פלטי `.migration/` ומ-git | – | `MIGRATION-V2-REPORT.md` (בלי commit) |

## run.js

```bash
cd <שורש השירות>
node <skill-dir>/scripts/run.js [--resume] [--answer <key>=<value>]... [--from <שלב>] [--only <שלב>] [--dry-run] [--yes] [--json]
```

- `--resume` – ממשיך מהשלב שנשמר ב-`.migration/state.json`
- `--answer branch.target=<שם>` – תשובה לנקודת האישור (אפשר לחזור על הדגל)
- `--from` / `--only` – לפי שמות השלבים בעמודה "שלב ב-run.js"
- `--yes` – דילוג על נקודות אישור (הרצת אצווה)

מסרב לרוץ כשה-cwd נמצא בתוך תיקיית הסקיל, כדי לא לכתוב state לתוך הסקיל.

## נתוני ייחוס

| קובץ | נקרא על ידי |
|---|---|
| `reference/versions.json` | preflight, scan, package-json, use-shared-state |
| `reference/deny-list.json` | scan |
| `reference/scan-rules.json` | scan, package-json |
| `reference/mui-mapping.json` | codemod-mui-imports |
| `reference/mui-slots.json`, `reference/sx-rules.json` | codemod-makestyles |
| `reference/commit-steps.json` | commit |

קבצי ה-`.md` ב-`reference/` הם תיעוד ל-Claude ולאדם. **מקור האמת הוא ה-JSON**.
