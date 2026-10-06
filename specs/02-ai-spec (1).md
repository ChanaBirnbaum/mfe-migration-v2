# SPEC – הקשר משותף

**שים בראש כל פרומפט.** מכיל את כל העובדות שכל סקריפט צריך. אחריו מגיע הפרומפט הספציפי.

---

## הפרויקט

אני בונה סקיל ל-Claude Code שמסב שירותי MFE מ-React 17 + Material-UI v4 ל-React 18 + MUI v7. הסקיל מורכב מ-`SKILL.md` (הנחיות) ו-15 סקריפטים ב-Node שמבצעים את כל השינויים בקוד.

**כל סקריפט נכתב בנפרד.** אתה כותב אחד בכל פעם.

## סביבה

- Node 18, JavaScript (CommonJS, `require` ולא `import`)
- `ts-morph` לניתוח ועריכת AST
- רשת סגורה – registry פנימי בלבד, אין גישה לאינטרנט בזמן ריצה
- הסקריפטים רצים משורת פקודה בשורש הריפו של השירות המוסב

## חוזה מחייב לכל סקריפט

```
1. השורה האחרונה בפלט: RESULT: OK | REVIEW | BLOCKED | NOOP
2. קוד יציאה 0 לכל התוצאות הצפויות, כולל BLOCKED ו-REVIEW
   קוד יציאה 1 שמור אך ורק לקריסה לא צפויה של הסקריפט עצמו
3. כל הפלט ל-stdout. stderr רק לקריסה אמיתית
4. --dry-run  : מדפיס מה היה משתנה, לא כותב לדיסק
5. --json     : מדפיס אובייקט תוצאה במקום טקסט קריא
6. idempotent : הרצה שנייה על ריפו שכבר טופל → NOOP, אפס שינויים
7. לא אינטראקטיבי : לעולם לא שואל שאלות. ספק → REVIEW
8. לא זורק exception לא מטופל : כל שגיאה צפויה → הודעה ברורה + BLOCKED
```

**⚠ מדוע קוד יציאה 0 גם ל-BLOCKED:** הסקריפטים מורצים על ידי Claude Code,
שמציג כל יציאה שאינה 0 כ-`Error` ועלול לבלוע את הפלט. אם ה-RESULT לא נקרא,
המודל לא יודע מה קרה ולא יכול לשאול את המשתמשת את השאלה הנכונה.
הסטטוס חייב לעבור דרך הפלט, לא דרך קוד היציאה.

**⚠ stdout בלבד:** בסביבות Git Bash על Windows יש רעש קבוע ב-stderr
(הרשאות /etc). פלט שנכתב ל-stderr יתערבב בו.

**פורמט `--json`:**
```json
{
  "script": "<שם>",
  "result": "OK",
  "changes": [{ "file": "src/X.jsx", "rule": "RULE.ID", "confidence": "auto|review" }],
  "manual":  [{ "file": "src/Y.jsx", "line": 42, "reason": "<בעברית>" }],
  "blockers": [],
  "notes": []
}
```

## כללי מימוש

1. **AST ולא regex.** קוד מוער חייב להישאר מוער ולא להיספר כשימוש.
2. **Prettier רק על קבצים שנגעת בהם**, לא על הריפו.
3. **טבלאות מיפוי נטענות מ-`reference/*.md` או `*.json` כדאטה** – לא מקודדות בסקריפט.
4. **עריכת JSON נקודתית** – שימור סדר מפתחות ופורמט מקורי. לא `JSON.stringify` על כל הקובץ.
5. **אין מחיקת קבצים** למעט `install.js`.
6. `--dry-run` חייב לעבור את אותו נתיב קוד בדיוק, רק בלי הכתיבה.

---

## עובדות על השירותים המוסבים

### package.json טיפוסי (לפני הסבה)

```json
{
  "name": "hasava-mfe",
  "version": "0.1.1",
  "dependencies": {
    "@emotion/react": "^11.5.0",
    "@emotion/styled": "^11.3.0",
    "@material-ui/core": "^4.12.3",
    "@material-ui/pickers": "^3.3.10",
    "@mui/icons-material": "^5.14.9",
    "@mui/material": "^5.0.6",
    "@mui/x-date-pickers": "^5.0.0-alpha.4",
    "babel-loader": "^8.2.2",
    "react": "^17.0.2",
    "react-dom": "^17.0.2",
    "react-router-dom": "^6.0.2",
    "react-scripts": "5.0.0",
    "rxjs": "^7.5.4"
  },
  "devDependencies": {
    "@babel/runtime": "^7.13.10",
    "axios": "^0.24.0",
    "react": "^17.0.2",
    "react-dom": "^17.0.2",
    "webpack": "^5.57.1",
    "webpack-cli": "^4.9.0",
    "webpack-dev-server": "^4.3.1"
  },
  "scripts": {
    "build": "webpack --mode production  --env sviva=prod",
    "build:dev": "webpack --mode production  --env sviva=dev",
    "build:test": "webpack --mode production  --env sviva=test",
    "start": "webpack serve --open --mode development  --env sviva=local"
  }
}
```

**שים לב:**
- `react` ו-`react-dom` מופיעים **בשני הבלוקים**. זה המצב הקיים ואין להסיר – יש לעדכן את שניהם לאותה גרסה.
- כלי build (`babel-loader`, `react-scripts`) יושבים ב-`dependencies`. **לא נוגעים.**
- כל פקודות ה-build דורשות `--env sviva=...`. `npm run build` סתם יקרוס.

### גרסאות היעד

```json
{
  "react": "^18.3.1",
  "react-dom": "^18.3.1",
  "react-router-dom": "^6.30.1",
  "@emotion/react": "^11.14.0",
  "@emotion/styled": "^11.11.0",
  "@mui/material": "^7.3.11",
  "@mui/icons-material": "^7.3.11",
  "@mui/x-date-pickers": "^9.3.0"
}
```
גרסת החבילה: `"version": "2.0.0"`

### webpack.config.js – המבנה בפועל

```js
const HtmlWebPackPlugin = require("html-webpack-plugin");
const ModuleFederationPlugin = require("webpack/lib/container/ModuleFederationPlugin");
const path = require('path');

const deps = require("./package.json").dependencies;

module.exports = ({ sviva }) => {
  const PORT = 8890;
  const envVriables = { local: {...}, dev: {...}, test: {...}, prod: {...} };

  const config = {
    output: envVriables[sviva].output,
    plugins: [
      new ModuleFederationPlugin({
        name: "MichsotSheten",
        filename: "remoteEntry.js",
        exposes: { './MichsotSheten': "./src/App.jsx" },
        shared: {
          ...deps,
          react: { singleton: true, requiredVersion: deps.react },
          "react-dom": { singleton: true, requiredVersion: deps["react-dom"] },
        },
      }),
      new HtmlWebPackPlugin({ template: "./src/index.html" }),
    ],
  };
  return config;
};
```

**חשוב:** הקובץ הוא **פונקציה** ולא אובייקט. הסקריפט חייב לאתר את `ModuleFederationPlugin` בתוכה.
`exposes` חושף **קומפוננטה**, לא mount/unmount API.

### buildSharedGen1 – מאומת מול המימוש

```js
const pkg = require("./package.json");
const { buildSharedGen1 } = require("@ips/mfe-shared-deps");
// ...
shared: buildSharedGen1({ pkg, require, role: 'remote' })
```

| | |
|---|---|
| `role` | `'host'` \| `'remote'` \| `'standalone'`. אין ברירת מחדל; ערך אחר → `FederationConfigError` |
| remote | `requiredVersion = '^17.0.0 \|\| ' + טווח מה-package.json`, `import: false` |
| host | הטווח בלבד, בלי רצפה |
| קוראת מ-pkg | `dependencies` + `peerDependencies` (peer גובר), `name` |
| `devDependencies` | **נחשב לא מוצהר** |
| הגרסה המותקנת | מ-`node_modules` דרך ה-`require` שמועבר |
| מנוהלות | `react`, `react-dom`, `react-router`, `react-router-dom` בלבד |

**משמעות:** תחת Host ישן הקוד רץ על React 17. אסור: `useId`, `useSyncExternalStore`, `useTransition`, `useDeferredValue`, `useInsertionEffect`.

### bootstrap.js – אחרי הסבה

```js
import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
```

### קובץ אמיתי עם makeStyles – שים לב למצב המעורב

```jsx
import * as React from 'react';
import TextField from '@mui/material/TextField';
import Autocomplete from '@mui/material/Autocomplete';
import Paper from '@mui/material/Paper';
import { makeStyles } from '@material-ui/core'     // ← v4 נשאר

const useStyles = makeStyles({
  paper: { direction: 'rtl', width: '160px', right: '0px', position: 'absolute' },
  option: {
    // borderBottom: '1px solid gray',              // ← ריק, הכל מוער
  }
});

export const SearchReport = ({ data, placeholder, onChange }) => {
  const classes = useStyles();
  return (
    <Autocomplete
      freeSolo
      options={data}
      classes={{ paper: classes.paper, option: classes.option }}
      renderInput={(params) => (
        <div ref={params.InputProps.ref}>
          <input {...params.inputProps} placeholder={placeholder}/>
        </div>
      )}
    />
  );
}
```

**שלוש נקודות מהדוגמה:**
1. קובץ יכול להיות **מעורב** – חלק `@mui`, חלק `@material-ui`. אל תניח שקובץ הוא כולו דור 1.
2. `paper` הוא slot של Autocomplete; `option` **אינו slot** אלא class hook. ההמרה שונה לכל אחד.
3. יש הרבה קוד מוער. **חובה AST.**

### החלטות סגורות

| נושא | הכרעה |
|---|---|
| Router | שדרוג ל-`^6.30.1` |
| `react`/`react-dom` ב-devDependencies | לעדכן לאותה גרסה, **לא להסיר** |
| `axios` כפול | לא נוגעים |
| כלי build ב-`dependencies` | לא נוגעים, הערה ב-`notes` |
| Date pickers | `review`, לא אוטומטי |
| בנייה | `npm run build:dev` |
| הרצה מקומית | `webpack serve --mode development --env sviva=local` (בלי `--open`) |

---

## מה אני מצפה לקבל

1. **קוד מלא של הסקריפט**, מוכן להרצה. לא שלד ולא pseudo-code.
2. **בדיקות** – golden files או בדיקות יחידה, לפי הסקריפט.
3. **הערות בעברית** רק במקומות שדורשים הסבר. הקוד באנגלית.

**אל תוסיף תלויות מעבר ל-`ts-morph` ולספריות הליבה של Node** בלי לציין זאת במפורש ולנמק.
