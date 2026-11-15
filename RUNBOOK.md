# הסבת שירות לדור 2 – הרצה ידנית מהטרמינל

הסקריפט מבצע את ההסבה: React 18, MUI v7 ו-`buildSharedGen1`. הוא עובד על בראנץ' חדש `digital_V2` ועושה commits לבד.
את ה-push עושים בעצמכם, בסוף.

**כל ההרצה היא פקודה אחת, תמיד אותה פקודה:**

```powershell
node C:\tools\mfe-migration-v2\scripts\run.js --auto
```

הסקריפט עוצר רק כשצריך לתקן משהו. אחרי התיקון מריצים שוב את אותה פקודה, והוא ממשיך מאיפה שעצר.

זמן משוער: 15–30 דקות להרצה, ועוד זמן לתיקוני build אם יהיו.

---

## 0. התקנה (פעם אחת לכל מחשב)

> **חשוב:** את הסקריפט שמים **מחוץ** לריפו של השירות. לא ב-`.claude/skills` של השירות.
> אחרת git של השירות רואה אותו כקבצים חדשים, וההרצה נעצרת על "git לא נקי".

מעתיקים את התיקייה `mfe-migration-v2`, **כולל `node_modules`**, ל-**`C:\tools\mfe-migration-v2`**.
כל הפקודות בקובץ הזה מניחות את הנתיב הזה.

```powershell
robocopy <התיקייה המשותפת>\mfe-migration-v2 C:\tools\mfe-migration-v2 /MIR
```

- **לא מריצים `npm ci` בתיקיית הסקיל.** `ts-morph` עדיין לא קיים ב-feed הפנימי, ולכן `npm ci` נכשל עם 404.
  התיקייה מגיעה כשהחבילות כבר מותקנות.
- לא מריצים את הסקריפט ישירות מנתיב רשת (`\\server\...`), אלא רק מהעותק המקומי.
  מנתיב רשת `ts-morph` לא נטען, ומופיעה הודעה מטעה שמבקשת להריץ npm install.
- כשמתפרסמת גרסה חדשה של הסקיל, מריצים שוב את אותה פקודת `robocopy`.

דרישות: Node 18 ומעלה, git, וגישה ל-registry הפנימי (בשביל ה-`npm install` של **השירות**).

> `npm ping` מול ה-feed ב-TFS נכשל תמיד, כי ה-feed לא תומך בפקודה הזו. זה לא חוסם את ההרצה:
> preflight מציג אזהרה ובודק את הגישה דרך `npm view`.

---

## 1. לפני ההרצה (בשירות)

```powershell
cd C:\path\to\my-service
git status
git checkout <הבראנץ' שממנו מסבים>
git pull
```

- [ ] `git status` נקי. אם לא: עושים commit או `git stash`.
- [ ] עומדים על הבראנץ' שממנו רוצים להסב. **`digital_V2` ייווצר ממנו בלי לשאול.**
- [ ] **מומלץ:** מריצים `npm run build:dev` ומוודאים שהוא עובר **לפני** ההסבה.
      כך יודעים אילו שגיאות היו קיימות קודם ואילו נגרמו מההסבה.

---

## 2. הרצה

מתוך **שורש השירות**:

```powershell
node C:\tools\mfe-migration-v2\scripts\run.js --auto
```

השורה האחרונה בפלט היא תמיד `RESULT: ...`.

| מה רואים | מה עושים |
|---|---|
| `RESULT: OK` | סיימנו. ראו סעיף 4 |
| `⏸ REVIEW` באמצע ההרצה | **לא צריך לעשות כלום עכשיו.** הסקריפט ממשיך לבד, והפריטים מרוכזים בדוח בסוף |
| `⛔ BLOCKED` | מטפלים בסיבה שהודפסה ומריצים שוב את אותה פקודה |
| `🔧 PAUSE_FOR_FIX` | ה-build נכשל. ראו סעיף 3 |
| `Approval needed: run the migration on the EXISTING branch` | `digital_V2` כבר קיים, אבל לא נוצר ע"י הסקריפט (למשל הסבה ידנית). **עוצרים ומתייעצים** |
| `continue with a local stub` | **לא מאשרים.** חבילה פנימית לא נמצאה, כנראה בגלל הגדרות npm. בודקים את `.npmrc` ומריצים שוב |
| `💥 FAILED` | באג בסקריפט. שומרים את הפלט ומעבירים לצוות הסקיל |

---

## 3. תיקון שגיאות build (`PAUSE_FOR_FIX`)

1. השגיאות מודפסות בפורמט `קובץ:שורה:עמודה – הודעה`. הרשימה המלאה נמצאת ב-`.migration\build-<n>.json`.
2. מחפשים כל שגיאה ב-`C:\tools\mfe-migration-v2\reference\known-errors.md` ומתקנים לפי מה שכתוב שם.
3. מתקנים בקוד **בלי commit**. הסקריפט יעשה commit לתיקונים בעצמו.
4. מריצים שוב את אותה פקודה. הסקריפט מריץ build שוב ומשווה למספר השגיאות הקודם.

יש עד 5 סבבים. אם מופיע `No progress` או `Reached the maximum`, עוצרים ומתייעצים.

אסור: `npm install --force` / `--legacy-peer-deps`. אם יש קונפליקט peer deps, מתייעצים.

---

## 4. אחרי `RESULT: OK`

- [ ] קוראים את `MIGRATION-V2-REPORT.md` בשורש השירות, **בעיקר את הסעיף "Needs manual handling"**.
      כל פריטי ה-REVIEW מההרצה נמצאים שם. בסוף הפלט מודפס גם באילו שלבים היו פריטים כאלה.
- [ ] מטפלים בפריטים הידניים מהדוח. אחרי זה: `git add` ו-`git commit` (את הדוח עצמו לא צריך להכניס).
- [ ] `npm start` ובדיקה ידנית של המסכים העיקריים.
- [ ] בודקים שהשירות עולה גם בתוך Host ישן (React 17) וגם בתוך Host חדש.
- [ ] `git log --oneline` – בודקים את ה-commits (`migration-v2: ...`).
- [ ] מעלים:

  ```powershell
  git push -u origin digital_V2
  ```

---

## להתחיל מההתחלה

```powershell
git checkout <בראנץ' המקור>
git branch -D digital_V2
Remove-Item -Recurse -Force .migration
node C:\tools\mfe-migration-v2\scripts\run.js --auto
```

נקודת ההתחלה של ההסבה מתויגת כ-`migration-start-<תאריך>`. התגים מופיעים ב-`git tag -l "migration-start-*"`.

---

## טיפים

- רוצים לראות מה יקרה לפני ההרצה? `node C:\tools\mfe-migration-v2\scripts\run.js --dry-run` לא כותב כלום.
- לא מריצים את הסקריפט מתוך `C:\tools\mfe-migration-v2`, רק מתוך השירות.
- ב-PowerShell כותבים כל פקודה בשורה נפרדת, בלי `&&`.
- התיקייה `.migration\` היא ה-state של ההרצה. לא עורכים אותה, והיא לא נכנסת ל-commit.
- אין צורך ב-`--resume` או ב-`--yes`. `--auto` כבר ממשיך לבד, ואף דגל לא מאשר מצב stub.
