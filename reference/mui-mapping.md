# מיפוי Material-UI v4 → MUI v7

> **מקור האמת הוא `mui-mapping.json`.** הקובץ הזה הוא תיעוד שלו, לשימוש בהמרה ידנית ובסבבי תיקון build.
> שינוי במיפוי נעשה ב-JSON, ואז כאן.

`codemod-mui-imports.js` מבצע את כל מה שמסומן "אוטומטי". מה שמסומן "ידני" נשאר עם הייבוא הישן
ומופיע ב-manual – וה-build ייכשל עליו, כי `package-json.js` מסיר את חבילות `@material-ui/*`.

## חבילות

| חבילה ישנה | יעד | אופן |
|---|---|---|
| `@material-ui/core` | `@mui/material` | אוטומטי |
| `@material-ui/core/<X>` | `@mui/material/<X>` | אוטומטי. נתיב עמוק יותר (`core/styles/x`) מסומן review |
| `@material-ui/icons` | `@mui/icons-material` | אוטומטי, **בלי** שינוי שמות (שמות האייקונים זהים) |
| `@material-ui/lab` | `@mui/material` לרכיבים שעברו (ראה למטה), אחרת `@mui/lab` | אוטומטי. מה שנשאר ב-`@mui/lab` מסומן review – החבילה אינה מוצהרת ב-package.json |
| `@material-ui/pickers` | `@mui/x-date-pickers` | אוטומטי + **review**: ה-API שונה לגמרי (LocalizationProvider, adapter, שמות רכיבים) |
| `@material-ui/styles` | אין | **ידני** – ראה "ממשקי JSS" |

## שינויי שמות (אוטומטי)

| v4 | v7 |
|---|---|
| `createMuiTheme` | `createTheme` |
| `MuiThemeProvider` | `ThemeProvider` |
| `fade` | `alpha` |
| `GridList` | `ImageList` |
| `GridListTile` | `ImageListItem` |
| `GridListTileBar` | `ImageListItemBar` |
| `ExpansionPanel` | `Accordion` |
| `ExpansionPanelSummary` | `AccordionSummary` |
| `ExpansionPanelDetails` | `AccordionDetails` |
| `ExpansionPanelActions` | `AccordionActions` |
| `theme.palette.type` / `palette: { type }` | `theme.palette.mode` / `palette: { mode }` |

כשהשם החדש כבר תפוס בקובץ, הייבוא נכתב כ-`newName as oldName` והשימושים לא משתנים.

## רכיבים שעברו מ-lab ל-`@mui/material`

`Alert`, `AlertTitle`, `Autocomplete`, `AvatarGroup`, `Pagination`, `PaginationItem`, `Rating`, `Skeleton`,
`SpeedDial`, `SpeedDialAction`, `SpeedDialIcon`, `ToggleButton`, `ToggleButtonGroup`, `usePagination`, `useAutocomplete`

## ממשקים שדורשים המרה ידנית

| ממשק | מה לעשות |
|---|---|
| `makeStyles` | מומר ב-`codemod-makestyles.js` (שלב 9). מופעים שתלויים ב-props נשארים לטיפול ידני: `sx` עם ערכים מחושבים, או `styled()` |
| `withStyles` | **לא נתמך ב-MUI v7.** המרה ל-`styled()` (רכיב עטוף) או ל-`sx` (סגנון חד-פעמי) |
| `createStyles` | **לא נתמך ב-MUI v7.** בתוך `makeStyles` הוא מוסר יחד איתו. בכל שימוש אחר – המרה ל-`styled()` או `sx` |
| `StylesProvider` | **לא נתמך ב-MUI v7.** בדרך כלל להסיר. אם שימש עם `injectFirst` לסדר טעינת ה-CSS – `StyledEngineProvider injectFirst` מ-`@mui/material/styles` |
| `Hidden` | הוסר ב-v5. `useMediaQuery` לתנאי בקוד, או `sx={{ display: { xs: 'none', md: 'block' } }}` להסתרה ב-CSS |
| `withWidth` | הוסר ב-v5. `useMediaQuery(theme.breakpoints.up('md'))` |
| `export … from '@material-ui/…'` | re-export – להמיר ידנית לפי הטבלאות למעלה |

הודעות ה-manual שהסקריפט מדפיס נלקחות מילה במילה מ-`mui-mapping.json`.
