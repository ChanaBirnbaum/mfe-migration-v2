# codemod-pickers.js — אפיון

## מטרה
הסבת `@mui/x-date-pickers` מגרסה 5 לגרסה 9 (React 18, ‏`@mui/material` 7.3, אפליקציה בעברית – RTL),
כולל יישור RTL של השדה שלא תלוי ב-theme (ב-MFE אין theme חיצוני משותף, ולכן ThemeProvider לא פותר את זה).

שלב 10 בצינור, אחרי `codemod-makestyles`; השינויים נכנסים ל-`commit-infra`.

## החלטות מימוש
- **ts-morph ולא jscodeshift**, כמו כל הקודמודים בסקיל: עריכות לפי מיקום ב-AST, כך ששורות שאף כלל לא נגע בהן
  נשארות זהות בייט-לבייט (זה מה ש-recast היה אמור להבטיח). אין תלות חדשה בסקיל.
- הקובץ מנותח מחדש אחרי כל עריכה, כך שכל כלל רואה את התוצאה של הכלל הקודם. כל כלל הוא פונקציה נפרדת עם מזהה.
- סדר הכללים בשלב 2: D1 D2 D3 D4 D6 D7 → R1.3 → C1 → D5 → C2 C3 → C5+D9 → C4 → C6 → D8 → R1 → M2 M4 M3 M5.
  C1 לפני D5 (C1 מעביר את `InputProps` וכו' ל-`slotProps.textField`), C5 לפני C4 (אחרי החלפת `handleChange(moment())`
  הרכיב אולי כבר לא תלוי ב-closure), R1 אחרון כדי לראות את `slotProps.textField` הסופי.
- הערת TODO נכתבת מעל השורה של הקוד: `// MIGRATION-TODO: <rule> <reason>`, ובתוך ילדי JSX ‏`{/* MIGRATION-TODO: … */}`.
  הערה זהה שכבר קיימת לא נכתבת שוב (אידמפוטנטיות). רשימת ה-TODO בדוח נאספת מהטקסט הסופי, כך שהשורות נכונות.
- תוצאה: TODO אחד לפחות או קודמוד שנכשל → `REVIEW` (כל TODO הוא פריט manual). הרצה שנייה שלא שינתה כלום → `NOOP`,
  והדוח של ההרצה שביצעה את ההסבה לא נדרס.

## CLI
| דגל | משמעות |
|---|---|
| `--config <path>` | קובץ קונפיגורציה במקום `pickers-migration.config.json` בשורש השירות |
| `--skip-official-codemods` | דילוג על שלב 1 (למשל בלי גישה ל-npm) |
| `--dry-run` | בלי כתיבה; שלב 1 לא רץ (npx כותב לקבצים) |
| `--json` | אובייקט התוצאה של הצינור |

## שלב 0 – קונפיגורציה
`pickers-migration.config.json` בשורש השירות (אופציונלי). מפתח חסר → ברירת מחדל:
```json
{ "rtlSxPlacement": "auto", "rtlSxSharedPath": "src/utils/pickersRtlSx.js", "invalidDateBehavior": "null" }
```
ערך לא חוקי, מפתח לא מוכר, JSON שבור או נתיב משותף מחוץ לפרויקט / בלי סיומת js|jsx|ts|tsx → `BLOCKED`
לפני שנוגעים בקובץ כלשהו (גם הקודמודים הרשמיים לא רצים).

## שלב 1 – הקודמודים הרשמיים
`npx --yes @mui/x-codemod@latest v{6,7,8,9}.0.0/pickers/preset-safe <files…>` ברצף, על כל קובץ שמייבא
`@mui/x-date-pickers` או `@mui/lab`. ריצה אחת לכל גרסה עם כל הקבצים; מהפלט (אחרי הסרת צבעי ANSI) נקראים
`N errors` ושורות ` ERR <file> Transformation error`. שגיאות שלא ניתן לשייך לקובץ → כל קובץ רץ שוב לבד.
אין שורת `errors` בכלל (npx נכשל, אין רשת) → כל הקבצים `failed` לאותה גרסה. קובץ שנכשל → `codemod-failed` בדוח,
ושלב 2 רץ עליו כרגיל.

נמצא בהרצה אמיתית (נובמבר 2026): v6 מעביר את `PaperProps` / `OpenPickerButtonProps` ל-`componentsProps` אבל משאיר
`components`, ואז v7 קורס על הקובץ (`rename-components-to-slots`, ‏`reading 'name'`). בקובץ אחר נשאר מפתח `ActionBar`
באות גדולה בתוך `slotProps`. D1 מטפל בשני המקרים.

## שלב 2 – הכללים
| כלל | מה | הערות מימוש |
|---|---|---|
| D1 | `components` → `slots`, ‏`componentsProps` → `slotProps`, אות ראשונה קטנה | גם מפתחות באות גדולה ב-`slots` / `slotProps` קיימים. קיים כבר יעד → מיזוג. spread (בתוך האובייקט או `{...x}` על ה-picker) → TODO |
| D2 | `inputFormat` → `format` | `format` כבר קיים → TODO |
| D3 | `PaperProps` → `slotProps.desktopPaper` + `mobilePaper` | |
| D4 | `OpenPickerButtonProps` → `slotProps.openPickerButton` | הביטוי עובר כמו שהוא |
| D5 | `InputProps` / `inputProps` / `InputLabelProps` / `FormHelperTextProps` בתוך `slotProps.textField` → `slotProps.textField.slotProps.{input, htmlInput, inputLabel, formHelperText}` | |
| D6 | `enableAccessibleFieldDOMStructure` נמחק | גם ב-`slotProps.field`; `field` שהתרוקן נמחק |
| D7 | `unstable*FieldRef` → `*FieldRef` | |
| D8 | מחרוזות CSS + מפתח theme `MuiPickersDay` → `MuiPickerDay` | כל המחרוזות בקובץ, כולל template של `styled`. המפתח – רק בתוך `components` |
| D9 | action bar → `usePickerActionsContext` | פרמטר שהוא מזהה בלבד; פרמטר מפורק עם `onClear` וכו' → TODO. גוף ביטוי הופך לבלוק עם `return` |
| C1 | `renderInput` → `slotProps.textField` | רק `TextField` מ-`@mui/material`, ‏`{...params}` יחיד, וערכים פשוטים. אחרת TODO |
| C2 | `moment()` סביב `value` / `minDate` / `maxDate` | ה-adapter נקבע מ-`LocalizationProvider` בקובץ; אין בקובץ → כל ה-providers בפרויקט; אין בכלל → TODO. ביטוי אחר (קריאה וכו') → TODO |
| C3 | `x?.toDate() \|\| null` → `x?.isValid() ? x.toDate() : null` | ב-onChange מוטמע או בפונקציה שהוא מפנה אליה. `"keep"` → לא נוגעים |
| C4 | רכיב slot שמוגדר בתוך רכיב → רמת המודול | closure = שמות שמוגדרים בפונקציות העוטפות (לא ברמת המודול). רכיב מוטמע בתוך `slots` → TODO |
| C5 | `f(moment())` / `f(dayjs())` / `f(new Date())` ב-action bar → `setValueToToday()` + TODO | |
| C6 | `FormHelperText` חיצוני באותו `FormControl` עם אותו ערך → `slotProps.textField.slotProps.formHelperText.sx` ומחיקה | אם הערך הגיע לשדה רק דרך `renderInput` (ש-v9 מתעלם ממנו) או כ-prop ישיר – גם `helperText` נוסף ל-`slotProps.textField`, כדי שהטקסט לא ייעלם. רינדור מותנה (`{x && <FormHelperText…>}`) → TODO |
| R1 | `sx: pickersRtlSx{Small,Medium}` ב-`slotProps.textField` (ראשון במערך) | DatePicker / DateTimePicker / TimePicker וגרסאות Desktop / Mobile שלהם. גודל: `slotProps.textField.size` ← `size` על ה-picker ← `FormControl` העוטף הקרוב. `slotProps` חדש נכנס **לפני** `{...spread}`, כדי לא לדרוס את מה שבו |
| R1.1 | מיקום הקבועים | inline: אחרי ה-imports, בלי `export`; אם יש כבר `base` ברמת המודול – `pickersRtlSxBase`. shared: הקובץ נוצר פעם אחת, import יחסי בלי סיומת |
| R1.3 | `ThemeProvider` עם `theme={(t) => ({ ...t, direction: 'rtl' })}` סביב picker → הוסר + TODO | ה-import נמחק אם לא בשימוש |
| M2 | ערך חשוד (`test`, `TODO`, `tmp`…) ב-props של ה-picker ובתוך ה-JSX שלו | |
| M3 | `direction: 'rtl'` על `MuiDateCalendar-root` / `rotate(180deg)` על `MuiPickersArrowSwitcher` | |
| M4 | `renderInput` / `components` / `componentsProps` / `inputFormat` שנשארו; picker שמיובא מ-`@mui/lab` | לא מסמן שוב שורה שכבר יש מעליה TODO של כלל אחר |
| M5 | `styleOverrides` / `defaultProps` של `MuiTextField` / `MuiOutlinedInput` / `MuiInputBase` / `MuiInputLabel` / `MuiFormHelperText` | רק כשיש pickers בפרויקט |

## R1.1 – התוכן המדויק
`RTL_SX_SOURCE` ב-`codemod-pickers.js` (מיוצא לבדיקות). ‏shared כותב אותו כמו שהוא, inline מוריד את `export`.

## דוח – migration-report.json
בשורש השירות, לא נכנס ל-commit (`excludePaths` ב-`reference/commit-steps.json`):
```json
{
  "config": { "rtlSxPlacement": "auto", "rtlSxPlacementResolved": "inline", "rtlSxSharedPath": "…", "invalidDateBehavior": "null" },
  "configSource": "defaults | <path>",
  "files": [{ "file": "…", "codemod": { "v6": "ok|failed|skipped", "…": "…" }, "applied": ["D1"], "todos": [{ "rule": "C1", "line": 42, "reason": "…" }], "status": "done | needs-review" }]
}
```
`status = needs-review` אם יש TODO או קודמוד שנכשל. קבצי theme (D8 / M5) מופיעים עם `codemod: skipped`.

## בדיקה ויזואלית אחרי ההסבה
לכל picker, ארבעה מצבים: שדה ריק, בפוקוס (ה-label עולה), עם תאריך, עם שגיאה. בכל מצב: התאריך, ה-label וטקסט השגיאה
מיושרים לימין, לא עולים על האייקון, והרווח במסגרת נמצא בדיוק מתחת ל-label.

## בדיקות
`tests/codemod-pickers.test.js`, fixtures ב-`tests/fixtures/pickers/<name>/{input,expected}.jsx`. כל golden רץ פעמיים
(הרצה שנייה = NOOP). ה-fixture המחייב: `ips-date-picker`.
