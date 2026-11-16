# mfe-migration-v2 – הסבת שירות MFE לדור 2

סקיל ל-Claude Code שמסב שירות MFE מ-**React 17 + Material-UI v4** ל-**React 18 + MUI v7**, עם תלויות משותפות
ב-Module Federation דרך `buildSharedGen1` (מהחבילה `@ips/mfe-shared-deps`).

ההסבה נעשית על בראנץ' חדש בשם `digital_V2`, שנוצר מהבראנץ' שעליו את/ה עומד/ת. הבראנץ' המקורי לא משתנה,
ושום דבר לא נדחף ל-origin.

---

## תוכן

- [מה צריך לפני שמתחילים](#מה-צריך-לפני-שמתחילים)
- [התקנה](#התקנה)
- [איך מפעילים](#איך-מפעילים)
- [מה קורה בתהליך](#מה-קורה-בתהליך)
- [נקודות עצירה – מתי Claude ישאל אותך](#נקודות-עצירה--מתי-claude-ישאל-אותך)
- [מה מקבלים בסוף](#מה-מקבלים-בסוף)
- [אחרי ההסבה](#אחרי-ההסבה)
- [הרצה ידנית ודגלים](#הרצה-ידנית-ודגלים)
- [בעיות נפוצות](#בעיות-נפוצות)
- [מבנה התיקייה](#מבנה-התיקייה)

---

## מה צריך לפני שמתחילים

| דרישה | פירוט |
|---|---|
| Node 18 ומעלה, git, npm | |
| Claude Code | CLI או תוסף VS Code |
| גישה ל-registry הפנימי | לחבילה `@ips/mfe-shared-deps`. בלי גישה אפשר להריץ רק "הרצת stub" – ראה [מצב stub](#מצב-stub) |
| עץ עבודה נקי בשירות | בלי שינויים פתוחים. ה-commit/stash לפני ההרצה |
| השירות בנוי כ-MFE | `webpack.config.js` עם `ModuleFederationPlugin`, וסקריפט `build:dev` ב-`package.json` |

---

## התקנה

בקצרה (הפירוט המלא ב-[INSTALL.md](INSTALL.md)):

1. העתיקו את התיקייה הזו ל-`~/.claude/skills/mfe-migration-v2/` (זמין בכל הפרויקטים),
   או ל-`<ריפו>/.claude/skills/mfe-migration-v2/` (לריפו אחד).
2. בתוך תיקיית הסקיל:

   ```bash
   npm ci
   ```

3. אופציונלי – הרצת הבדיקות של הסקיל: `npm test`.

---

## איך מפעילים

1. פתחו את Claude Code **בשורש הריפו של השירות** (לא בתיקיית הסקיל).
2. עברו לבראנץ' שממנו רוצים להתחיל את ההסבה (בדרך כלל הבראנץ' הראשי של הפיתוח).
3. בקשו מ-Claude, למשל:

   > תסב את השירות לדור 2

   או: `migrate this service to React 18 / MUI v7`, או הפעלה ישירה: `/mfe-migration-v2`.

4. Claude מריץ את הצינור, עוצר בנקודות החלטה ושואל אותך, ומתקן שגיאות build בעצמו.
5. בסוף מקבלים סיכום ודוח `MIGRATION-V2-REPORT.md` בשורש השירות.

אפשר גם לבקש:

| בקשה | מה יקרה |
|---|---|
| "תראה לי מה ייעשה בלי לשנות כלום" | הרצה עם `--dry-run` |
| "תמשיך את ההסבה" | המשך מהנקודה שבה נעצר (`--resume`) |
| "תתחיל מחדש" | הרצה מהשלב הראשון (`--from preflight`) |

---

## מה קורה בתהליך

הסקיל מבוסס על מתזמר (`scripts/run.js`) שמריץ **18 שלבים** לפי הסדר. כל שלב הוא סקריפט דטרמיניסטי
(codemods מבוססי AST עם `ts-morph`), כך שרוב העבודה לא נעשית ע"י המודל אלא ע"י קוד שנבדק.
Claude אחראי על ההרצה, על נקודות ההחלטה ועל תיקון שגיאות ה-build שהקודמודים לא סגרו.

המצב נשמר ב-`.migration/state.json` בשירות, כך שאפשר לעצור בכל נקודה ולהמשיך אחר כך.

### שלב א' – בדיקות והכנה

| # | שלב | מה קורה |
|---|---|---|
| 1 | `preflight` | בדיקות סביבה: ריפו git, עומדים על בראנץ', עץ נקי, גרסת Node, גישה ל-registry, וגרסאות היעד קיימות בו. לא כותב דבר |
| 2 | `scan` | מלאי מלא של השירות: ייבואי Material-UI, `makeStyles`, שימושי React, router ועוד. חבילות מרשימת האסורות (`reference/deny-list.json`) עוצרות את התהליך. נשמר ב-`.migration/inventory.json` |
| 3 | `branch` | יוצר את `digital_V2` מהבראנץ' הנוכחי ומתייג `migration-start-<תאריך-שעה>` – נקודת חזרה. **נקודת אישור:** Claude ישאל מאיזה בראנץ' להסתעף |

### שלב ב' – שינויים מכניים → commit ראשון

| # | שלב | מה קורה |
|---|---|---|
| 4 | `package-json` | מעדכן גרסאות: React 18, ‏`@mui/material` 7, Emotion, ‏`@ips/mfe-shared-deps`, ‏`@types/react` 18; מסיר את חבילות `@material-ui/*`. העריכה נקודתית ושומרת על הפורמט של הקובץ |
| 5 | `codemod-mui-imports` | ממיר ייבואים `@material-ui/*` ל-`@mui/*`, כולל שינויי שמות של קומפוננטות ואייקונים ו-`palette.type` שהופך ל-`palette.mode` |
| 6 | `codemod-react18` | `createRoot` במקום `ReactDOM.render` ב-bootstrap, הסרת `defaultProps` בקומפוננטות פונקציה, ‏`children` מפורש ב-`FC` (TypeScript) |
| 7 | `codemod-anti-patterns` | `useEffect(async …)` מוחלף בפונקציה פנימית עם cancelled guard (מתאים ל-StrictMode של React 18) |
| 8 | `commit-mechanical` | commit לשלבים 4–7 |

### שלב ג' – סגנונות ותשתית → commit שני

| # | שלב | מה קורה |
|---|---|---|
| 9 | `codemod-makestyles` | `makeStyles` מוחלף באובייקטי סגנון דרך `sx` / `slotProps` של MUI v7 |
| 10 | `use-shared-state` | מתקין את הגרסה העדכנית של `useSharedState` מתוך `assets/` (עם אימות sha256) ובודק את מקומות השימוש בו |
| 11 | `webpack-shared` | מחליף את הגדרת ה-`shared` ב-`webpack.config.js` בקריאה ל-`buildSharedGen1({ pkg, require, role })` |
| 12 | `commit-infra` | commit לשלבים 9–11 |

### שלב ד' – התקנה, build ואימות → commit שלישי

| # | שלב | מה קורה |
|---|---|---|
| 13 | `install` | מוחק `node_modules` ו-`package-lock.json` ומריץ `npm install` נקי. **אף פעם לא** `--legacy-peer-deps` / `--force` |
| 14 | `webpack-validate` | טוען את `webpack.config.js` ומוודא ש-`buildSharedGen1` עובד מול החבילה המותקנת |
| 15 | `build` | `npm run build:dev`. אם נכשל – **סבב תיקון**: Claude מתקן לפי [reference/known-errors.md](reference/known-errors.md) ומריץ שוב. עד 5 סבבים, ועצירה אם מספר השגיאות לא יורד בשני סבבים רצופים |
| 16 | `verify-runtime` | מרים את שרת הפיתוח (בלי דפדפן) ובודק ש-`remoteEntry.js` והדף הראשי נטענים |
| 17 | `commit-build-fixes` | commit לתיקוני ה-build |
| 18 | `report` | כותב את `MIGRATION-V2-REPORT.md` (לא נכנס ל-commit) |

> **למה React 18 בקוד אבל זה עדיין עובד תחת Host ישן?**
> `buildSharedGen1` מגדיר את React ו-router כ-singleton שה-Host מספק. תחת Host ישן השירות רץ בפועל על React 17,
> ולכן אסור להוסיף לקוד hooks שקיימים רק ב-18 (`useId`, `useTransition` וכו'). ההסבר המלא ב-[reference/coexistence.md](reference/coexistence.md).

---

## נקודות עצירה – מתי Claude ישאל אותך

| מתי | מה תתבקש/י להחליט |
|---|---|
| יצירת הבראנץ' | לאשר מאיזה בראנץ' ליצור את `digital_V2` (ברירת מחדל: הנוכחי). אפשר לבחור מקור אחר או שם יעד אחר |
| `digital_V2` כבר קיים ונוצר ע"י הסקיל | האם להמשיך את ההסבה הקודמת עליו |
| `digital_V2` קיים אבל **לא** נוצר ע"י הסקיל | (למשל הסבה ידנית) – האם להריץ את ההסבה על גביו. לפני כן נוצר תג נקודת שחזור |
| שלב שסיים עם `REVIEW` | השלב ביצע שינויים, אבל יש פריטים (קובץ:שורה – סיבה) שצריכים עין אנושית. ממשיכים אחרי אישור |
| שלב שנחסם (`BLOCKED`) | השלב לא הושלם – למשל חבילה אסורה או קונפליקט peer deps. צריך לטפל ואז להמשיך |
| ה-build לא מתקדם | Claude עוצר ושואל איך להמשיך, במקום להמשיך בסבבים בלי סוף |
| חבילה פנימית לא נמצאה | האם להמשיך במצב stub (ראה מטה) |

### מצב stub

אם `@ips/mfe-shared-deps` לא נגישה (למשל עבודה מחוץ לרשת הפנימית), אפשר לאשר הרצה מול stub מקומי שמגיע עם הסקיל.

- הרצה כזו בודקת **רק את מנגנון הצינור**, לא את ההסבה מול החבילה האמיתית.
- **לא מתבצע אף commit** – `package.json` מצביע לנתיב מקומי, והבראנץ' היה נשבר אצל כל מי שימשוך אותו.
- בסיום צריך להריץ שוב ממקום עם גישה לרשת הפנימית.

פירוט: [specs/stub-mode.md](specs/stub-mode.md).

---

## מה מקבלים בסוף

**בגיט:**

- בראנץ' `digital_V2` עם שלושה commits (`migration-v2: …`): שינויים מכניים, תשתית, תיקוני build.
- תג `migration-start-<תאריך-שעה>` על נקודת ההתחלה.

**בשורש השירות (לא נכנס ל-commit):**

| נתיב | תוכן |
|---|---|
| `MIGRATION-V2-REPORT.md` | דוח ההסבה: מה שונה בכל שלב, ובעיקר הסעיף **Needs manual handling** |
| `.migration/` | ה-state של הצינור, הפלט של כל שלב וגיבויים. מוחרג אוטומטית דרך `.git/info/exclude` |

---

## אחרי ההסבה

1. קראו את הסעיף **Needs manual handling** בדוח וטפלו בפריטים שם.
2. הריצו את השירות (`npm start`) ובדקו ויזואלית את המסכים – בעיקר מסכים שהשתמשו ב-`makeStyles` ובתאריכונים.
3. בדקו את השירות גם תחת Host ישן וגם תחת Host חדש.
4. כשהכול תקין – דחפו את `digital_V2` ופתחו PR. **הסקיל לא דוחף בעצמו.**

**לחזור אחורה:** הבראנץ' המקורי לא נגע. אפשר פשוט לחזור אליו ולמחוק את `digital_V2`,
או לחזור לנקודת ההתחלה עם התג `migration-start-*`.

---

## הרצה ידנית ודגלים

בדרך כלל Claude מריץ את הפקודות, אבל אפשר להריץ ישירות (משורש השירות):

```bash
node <תיקיית הסקיל>/scripts/run.js [דגלים]
```

| דגל | משמעות |
|---|---|
| `--dry-run` | מה היה קורה, בלי לכתוב דבר. שלבים מאוחרים רצים על קוד שלא הוסב, ולכן רק התוצאות של preflight, ‏scan ו-branch מעידות |
| `--resume` | המשך מהשלב השמור |
| `--from <שלב>` | התחלה משלב מסוים |
| `--only <שלב>` | הרצת שלב בודד |
| `--answer branch.source=<שם>` | אישור בראנץ' המקור |
| `--answer branch.target=<שם>` | שם אחר לבראנץ' היעד במקום `digital_V2` |
| `--answer stub.mode=yes` | אישור מצב stub |
| `--answer webpack.role=remote\|host` | תפקיד ב-federation לשירות היברידי (גם `exposes` וגם `remotes`) |
| `--yes` | דילוג על נקודות אישור (הרצת אצווה). לא מאשר מצב stub |
| `--auto` | הרצה עצמאית של מפתח מהטרמינל ([RUNBOOK.md](RUNBOOK.md)): בלי אישור בראנץ', בלי עצירה על REVIEW, והרצה חוזרת של אותה פקודה ממשיכה לבד |
| `--json` | פלט JSON במקום טקסט |

השורה האחרונה בפלט היא תמיד `RESULT: OK | PAUSE | PAUSE_FOR_FIX | FAILED | NOOP`, והפקודה להמשך מודפסת בשורה `Next:`.
הפלט באנגלית בכוונה – עברית מתהפכת בטרמינל של Windows.

פירוט כל שלב והדגלים שלו: [scripts/README.md](scripts/README.md).

---

## בעיות נפוצות

| תסמין | סיבה ופתרון |
|---|---|
| `PAUSE` עם `from inside the skill folder` | ההרצה נעשתה מתוך תיקיית הסקיל. עברו לשורש השירות |
| כל הקודמודים מחזירים `BLOCKED` על `ts-morph` | לא הורץ `npm ci` בתיקיית הסקיל |
| `preflight` חוסם על עץ עבודה לא נקי | בצעו commit או stash לשינויים הפתוחים |
| `install` חוסם על `ERESOLVE` | קונפליקט peer deps. ההחלטה שלך – הסקיל לא יעקוף עם `--force` |
| `npm run build` נכשל | הקונפיג דורש `--env sviva=...`. הסקיל משתמש ב-`npm run build:dev` |
| `A previous run did not finish` | יש הרצה קודמת שלא הושלמה. בחרו בין המשך להתחלה מחדש |
| `belongs to service` | ה-state ב-`.migration/` שייך לשירות אחר – בדקו שאתם בתיקייה הנכונה |
| תיקייה `.migration/` בתוך תיקיית הסקיל | מישהו הריץ סקריפט בודד מתוכה. מחקו אותה |

---

## מבנה התיקייה

| נתיב | תוכן |
|---|---|
| [SKILL.md](SKILL.md) | ההוראות ל-Claude – איך להריץ ולטפל בכל עצירה |
| [INSTALL.md](INSTALL.md) | הוראות התקנה מלאות |
| [scripts/](scripts/) | המתזמר והסקריפטים של כל שלב. פירוט ב-[scripts/README.md](scripts/README.md) |
| [reference/](reference/) | נתוני ייחוס: גרסאות היעד (`versions.json`), מיפוי MUI, רשימת אסורות, שגיאות build מוכרות. **מקור האמת הוא קבצי ה-JSON** |
| [assets/](assets/) | `useSharedState` בגרסה שמותקנת בשירות |
| [specs/](specs/) | אפיונים: הצינור כולו, יצירת הבראנץ', מצב stub |
| [test-fixtures/](test-fixtures/) | stub של `@ips/mfe-shared-deps` – למצב stub בלבד |
| [tests/](tests/) | בדיקות הסקיל (`npm test`) |

עדכון גרסאות יעד נעשה רק ב-[reference/versions.json](reference/versions.json) – הסקריפטים לא מקודדים גרסאות.
