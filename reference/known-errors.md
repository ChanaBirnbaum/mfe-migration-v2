# שגיאות מוכרות בהסבה – ותיקונן

לשימוש בסבב תיקון build (`PAUSE_FOR_FIX`). build.js מדפיס כל שגיאה בפורמט:

```
⛔ [<source> <code>] <קובץ>:<שורה>:<עמודה> – <הודעה>
```

חפש לפי ה-code או לפי טקסט ההודעה. הפירוט המלא, כולל הפלט המקורי (`raw`), נמצא ב-`.migration/build-<n>.json`.

**כלל לכל התיקונים:** שינוי מינימלי בקוד המקור. לא לשנות את `package.json` כדי "להחזיר" חבילת `@material-ui/*`,
לא `--legacy-peer-deps` / `--force`, ולא `npm run build` בלי `:dev`.

---

## ייבוא וחבילות

### `[webpack MODULE_NOT_FOUND] Can't resolve '@material-ui/…'`

**סיבה:** ייבוא v4 שהקודמוד השאיר בכוונה, כי אין לו המרה אוטומטית. החבילה הוסרה מ-package.json.
הפריט מופיע גם ב-manual של `codemod-mui-imports`.

**תיקון** – לפי מה שמיובא, ראה [mui-mapping.md](mui-mapping.md#ממשקים-שדורשים-המרה-ידנית):

| מיובא | תיקון |
|---|---|
| `withStyles` | `styled()` לרכיב עטוף, `sx` לסגנון חד-פעמי |
| `makeStyles` שתלוי ב-props | `sx` עם ערכים מחושבים, או `styled()` |
| `createStyles` מחוץ ל-makeStyles | להסיר את העטיפה; האובייקט עצמו עובר ל-`sx` / `styled()` |
| `StylesProvider` | להסיר, או `StyledEngineProvider injectFirst` מ-`@mui/material/styles` |
| `Hidden` / `withWidth` | `useMediaQuery`, או `sx={{ display: { … } }}` |
| `export … from '@material-ui/…'` | להמיר את ה-re-export לפי טבלאות המיפוי |

### `[webpack MODULE_NOT_FOUND] Can't resolve '@mui/lab'`

**סיבה:** רכיב lab שלא עבר ל-`@mui/material` (הרשימה ב-mui-mapping.md). `@mui/lab` אינו מוצהר ב-package.json.

**תיקון:** בדוק אם הרכיב עבר לחבילה אחרת בגרסה הנוכחית. אם לא – הוספת `@mui/lab` בגרסה שתואמת ל-`@mui/material` 7
היא **החלטה של המשתמשת**, כי היא מוסיפה תלות. הצג לה את הקבצים והרכיבים לפני שינוי.

### `[webpack EXPORT_NOT_FOUND] export 'X' (imported as 'X') was not found in '@mui/material'`

**סיבה:** שם שהשתנה או הוסר, שהקודמוד לא ראה – בדרך כלל ייבוא דרך re-export מקומי, נתיב עמוק, או ייבוא דינמי.

**תיקון:** אם `X` מופיע בטבלת "שינויי שמות" ב-mui-mapping.md – החלף לשם החדש. אם `X` הוא `Hidden` / `withWidth` – ראה למעלה.

### `[webpack EXPORT_NOT_FOUND] export 'KeyboardDatePicker' … was not found in '@mui/x-date-pickers'`

**סיבה:** ה-API של בוררי התאריכים שונה לגמרי בין `@material-ui/pickers` ל-`@mui/x-date-pickers`.
package-json.js סימן את המעבר כ-review והוסיף פריט manual לכל קובץ.

**תיקון (ידני, עם המשתמשת):** הרכיבים `Keyboard*Picker` הוחלפו ב-`DatePicker` / `TimePicker` / `DateTimePicker`,
והעץ צריך `LocalizationProvider` עם adapter של ספריית התאריכים שבשימוש. ספריית התאריכים חייבת להיות מותקנת –
אם היא לא ב-package.json, זו תלות חדשה ודורשת אישור.

### `[webpack MODULE_NOT_FOUND] Can't resolve 'react-dom/client'`

**סיבה:** react-dom 17 עדיין מותקן – install לא רץ, או רץ עם lock ישן.

**תיקון:** אל תשנה את הקוד. הרץ שוב את ההתקנה: `--from install`.

---

## TypeScript

### `[tsc TS2322]` / `[tsc TS2339]` עם `Property 'children' does not exist`

**סיבה:** ב-React 18 ‏`React.FC` כבר לא כולל `children` באופן מובלע. codemod-react18 מוסיף `children?: ReactNode`
רק כשטיפוס ה-props מוגדר באותו קובץ.

**תיקון:** הוסף `children?: React.ReactNode` לטיפוס ה-props – בקובץ שבו הוא מוגדר, גם אם הוא מיובא.

### `[tsc TS2786] 'X' cannot be used as a JSX component`

**סיבה:** שתי גרסאות של `@types/react` בעץ (17 ו-18) – בדרך כלל ספרייה שמושכת את הישנה.

**תיקון:** בדוק `npm ls @types/react`. אם `@types/react` / `@types/react-dom` מוצהרים – הם כבר עודכנו ל-`^18`.
התלות שמושכת 17 דורשת שדרוג – הצג למשתמשת לפני שינוי ב-package.json.

---

## Module Federation

### `FederationConfigError`

**סיבה:** `buildSharedGen1` קיבלה `role` לא חוקי, או `pkg` / `require` חסרים.
אמור להיתפס כבר בשלב `webpack-validate` ולא להגיע ל-build.

**תיקון:** `role` חייב להיות `'host'`, ‏`'remote'` או `'standalone'` (אין ברירת מחדל).
שירות שחושף קומפוננטה ב-`exposes` הוא `'remote'`. שירות עם `exposes` וגם `remotes` – החלטה של המשתמשת.

### `TypeError: Cannot read properties of undefined (reading 'output')`

**סיבה:** ה-build רץ בלי `--env sviva=…`, ולכן `envVriables[sviva]` הוא `undefined`.

**תיקון:** אל תשנה את הקונפיג. הפקודה היא `npm run build:dev`. אם הורץ `build.js --command` עם פקודה אחרת – זו הבעיה.

---

## התקנה (שלב install, לא build)

### `ERESOLVE – קונפליקט peer dependencies`

**סיבה:** חבילה שה-peerDependencies שלה לא מאפשרות React 18 / MUI 7.

**תיקון:** **לעולם לא `--legacy-peer-deps` או `--force`.** install.js מדפיס את עץ הקונפליקט.
מצא את החבילה שמגבילה, ובדוק אם היא ב-[deny-list.json](deny-list.json) – שם מופיעה הגרסה המתקנת או החלופה.
השדרוג או ההחלפה הם החלטה של המשתמשת.

### `404 – החבילה … לא נמצאה ב-registry`

**סיבה:** הגרסה ב-package.json לא קיימת ב-registry הפנימי. preflight אמור היה לתפוס את זה.

**תיקון:** אם החבילה היא מ-`versions.json` – הגרסה שם שגויה, ויש לעדכן אותה בסקיל. אחרת – בירור מול צוות ה-registry.

---

## זמן ריצה (verify-runtime / דפדפן)

### `Warning: ReactDOM.render is no longer supported in React 18`

**סיבה:** `ReactDOM.render` מחוץ ל-bootstrap. codemod-react18 ממיר רק את ה-bootstrap, ושאר המופעים ב-manual.

**תיקון:** אם זה רינדור לתוך portal או חלון – `createPortal`. אחרת `createRoot(el).render(…)` ושמירת ה-root ל-`unmount()`.

### `Invalid hook call` / `more than one copy of React`

**סיבה:** שני עותקי React בדף – `shared` לא מוגדר דרך `buildSharedGen1`, או ספרייה שמביאה React משלה.

**תיקון:** ודא ש-`webpack.config.js` משתמש ב-`buildSharedGen1` (שלב webpack-shared). אחר כך `npm ls react`.

### `MUI: The \`styles\` argument provided is invalid. You are providing a function without a theme in the context.`

**סיבה:** `makeStyles` מ-`@mui/styles` עם פונקציית theme, בלי `ThemeProvider` של `@mui/styles`.
codemod-makestyles לא נוגע ב-`@mui/styles`.

**תיקון:** המרה של ה-makeStyles ל-`sx` / `styled()` (מועדף), או עטיפה ב-`ThemeProvider` מ-`@mui/styles`.

---

## כשההודעה לא כאן

- `[webpack UNPARSED_FAILURE]` – build.js לא הצליח לפרק את הפלט. קרא את `raw` ב-`.migration/build-<n>.json`.
- `[webpack TIMEOUT]` – ה-build לא הסתיים בזמן. הצג למשתמשת; אפשר להאריך עם `build.js --timeout`.
- שגיאה שאינה קשורה להסבה (קיימת גם ב-`digital_V2` לפני ההסבה) – אל תתקן אותה במסגרת ההסבה. דווח עליה.
