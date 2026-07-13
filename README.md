# Vocora

یک اپ full-stack برای تمرین واژگان با جعبهٔ لایتنر؛ در نسخهٔ فعلی با تمرکز بر املای IELTS Listening. حساب‌ها و تمام وضعیت یادگیری کاربران در MySQL ذخیره می‌شود و با ورود از دستگاه‌های مختلف قابل دسترسی است.

## ساختار پروژه

```text
.
├── ui/                  # HTML, CSS, JavaScript, Login و Register
├── back/                # Node.js + Express با معماری لایه‌ای
│   ├── database/        # schema.sql
│   ├── scripts/         # ساخت خودکار database و tableها
│   ├── src/
│   │   ├── domain/
│   │   ├── application/
│   │   ├── infrastructure/
│   │   └── interfaces/
│   └── tests/
├── docker-compose.yml   # App + MySQL + phpMyAdmin
└── .env.example
```

لایه‌های Domain و Application به Express یا MySQL وابسته نیستند. Repositoryها و سرویس‌های امنیتی از طریق dependency injection به use caseها داده می‌شوند تا منطق مستقل، قابل‌تست و قابل‌تعویض بماند.

## اجرای سریع با Docker

پیش‌نیاز: Docker و Docker Compose.

```bash
cp .env.example .env
# مقدارهای password و JWT_SECRET را در .env تغییر دهید
docker compose up --build
```

سپس باز کنید:

- برنامه: [http://localhost:3000](http://localhost:3000)
- phpMyAdmin: [http://localhost:8081](http://localhost:8081)
- سلامت API: [http://localhost:3000/api/health](http://localhost:3000/api/health)

Compose بدون `DB_PASSWORD`، `DB_ADMIN_PASSWORD`، `MYSQL_ROOT_PASSWORD` و `JWT_SECRET` اجرا نمی‌شود. مقدارهای نمونه را در `.env` تغییر دهید؛ رمز admin باید با `MYSQL_ROOT_PASSWORD` یکسان باشد. phpMyAdmin به‌صورت پیش‌فرض فقط روی `127.0.0.1` منتشر می‌شود.

برای توقف بدون حذف اطلاعات:

```bash
docker compose down
```

برای حذف کامل volume دیتابیس و شروع از صفر:

```bash
docker compose down -v
```

## ساخت خودکار دیتابیس

هنگام بالا آمدن stack، سرویس یک‌باراجرای `db-setup` دستور زیر را خودکار اجرا می‌کند و فقط پس از موفقیت آن، سرویس وب شروع می‌شود:

```bash
cd back
npm run db:setup
```

این اسکریپت قابل‌تکرار و idempotent است: اتصال MySQL را با retry بررسی می‌کند، database را در صورت نبودن می‌سازد، دسترسی محدود کاربر برنامه را تنظیم می‌کند و `back/database/schema.sql` را اجرا می‌کند. اطلاعات root فقط در همین سرویس کوتاه‌عمر قرار می‌گیرد و به process وب داده نمی‌شود.

جدول‌ها:

- `users`: ایمیل یکتا و password hash شده
- `learning_states`: تمام لغات، خانه‌ها، موعدها، خطاها، تاریخچه، آمار روزانه و تنظیمات هر کاربر در یک ستون JSON متعلق به همان کاربر

phpMyAdmin فقط رابط مدیریت MySQL است؛ دیتابیس اصلی MySQL است.

## اجرای محلی بدون Docker

یک MySQL در دسترس قرار دهید، متغیرهای `.env` را برای host محلی تنظیم کنید و سپس:

```bash
cd back
npm install
npm run db:setup
npm run dev
```

Express فایل‌های پوشهٔ `ui/` و API را از یک origin در پورت ۳۰۰۰ ارائه می‌کند.

## احراز هویت

- ثبت‌نام فقط با email و password
- ذخیرهٔ password با bcrypt hash؛ هیچ password خامی ذخیره نمی‌شود
- session با JWT در cookie از نوع `HttpOnly` و `SameSite=Lax`
- محدودسازی درخواست‌های login/register برای کاهش brute-force
- تمام endpointهای وضعیت یادگیری نیازمند login هستند
- رابط کاربری هیچ وضعیت یادگیری را در `localStorage` ذخیره نمی‌کند

برای کاربر قدیمی، اگر database هنوز state نداشته باشد، رابط یک‌بار دادهٔ نسخهٔ localStorage را به حساب وارد می‌کند و سپس کلید قدیمی را حذف می‌کند.

## API

| Method | Path | کاربرد |
|---|---|---|
| `GET` | `/api/health` | healthcheck |
| `POST` | `/api/auth/register` | ساخت حساب |
| `POST` | `/api/auth/login` | ورود |
| `GET` | `/api/auth/me` | کاربر فعلی |
| `POST` | `/api/auth/logout` | خروج |
| `GET` | `/api/state` | دریافت state کاربر |
| `PUT` | `/api/state` | ذخیرهٔ کامل state کاربر |

`GET /api/state` مقدارهای `state` و `revision` را برمی‌گرداند. درخواست `PUT` باید همان `revision` را همراه state بفرستد؛ ذخیرهٔ موفق revision را افزایش می‌دهد و نوشتن از یک تب یا دستگاه قدیمی با `409 STATE_CONFLICT` متوقف می‌شود تا دادهٔ جدیدتر بازنویسی نشود.

## تست‌ها

```bash
cd back
npm test

cd ../ui
npm install
npm test
```

تست‌ها منطق use caseها، validation، authentication، API و رفتارهای اصلی رابط را مستقل از MySQL واقعی بررسی می‌کنند.

گردش‌کار GitHub Actions علاوه بر این تست‌ها، کل stack شامل MySQL، phpMyAdmin و app را با Docker بالا می‌آورد و ثبت‌نام و نوشتن/خواندن state از دیتابیس را smoke-test می‌کند.

## ورود لغات جدید

در «بانک واژه‌ها» فایل Markdown یا TXT با ساختار زیر را import کنید:

```md
## Travel
1. accommodation
2. itinerary
3. centre / center
```

املاهای اصلی و جایگزین، حروف بزرگ و کوچک، فاصله‌های اضافی و موارد تکراری داخل همان فایل بررسی می‌شوند؛ فقط لغات واقعاً جدید به state کاربر در دیتابیس اضافه می‌شوند.

## استوری پیشرفت و گیمیفیکیشن

کاربر می‌تواند از صفحهٔ خانه یا پس از پایان جلسه، یک Story استاندارد `1080 × 1920` از پیشرفت واقعی خود بسازد. Vocora بر اساس داده‌های موجود بهترین روایت را از میان نتیجهٔ جلسه، هدف روزانه، پیوستگی، تسلط و رشد هفتگی پیشنهاد می‌دهد. تصویر کاملاً در مرورگر ساخته می‌شود و ایمیل، پاسخ‌های تایپ‌شده، نام واژه‌ها یا جزئیات خطاهای کاربر را در خود ندارد.

در موبایل و روی HTTPS، برنامه از Web Share API و Share Sheet سیستم‌عامل استفاده می‌کند؛ اگر اشتراک فایل پشتیبانی نشود، تصویر PNG برای بارگذاری دستی ذخیره می‌شود. بازشدن مستقیم Instagram از وب تضمین‌پذیر نیست و مقصد را کاربر در Share Sheet انتخاب می‌کند.

منطق علمی، مرزهای اخلاقی، تعریف معیارها و نقشهٔ راه فازهای بعدی در [سند گیمیفیکیشن](docs/GAMIFICATION.md) آمده است.
