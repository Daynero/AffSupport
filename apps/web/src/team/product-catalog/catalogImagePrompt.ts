import { analytics } from '../../analytics/service';

export const CATALOG_IMAGE_PROMPT_VERSION = 'catalog-clothing-v1';

export const CATALOG_IMAGE_PROMPT =
  "Створи 100 окремих товарних зображень одягу для каталогу Soty. Якщо я вказав іншу кількість у цьому запиті, використай її. Потрібні готові файли, а не лише описи чи промпти.\n\nВИГЛЯД КОЖНОЇ КАРТИНКИ\n1. Квадрат 1:1, рекомендовано 1024×1024. Один цілий предмет одягу на одному окремому зображенні. Реалістична студійна предметна фотографія, ракурс спереду або акуратний flat lay; одяг добре впізнається і повністю вміщується в кадрі з невеликими відступами.\n2. Чисте біле тло, без прозорості, декорацій і зайвих предметів. М'яке нейтральне світло, природна фактура й правдивий колір, без кольорових фільтрів. Білий/кремовий одяг повинен мати видимі краї й деталі на білому тлі.\n3. Лише одяг. Без людей, частин тіла, видимого манекена, вішалок, взуття, сумок, прикрас чи інших аксесуарів. Не створюй комплект із кількох речей, колаж, сітку або спрайт-лист.\n4. Жодних реальних або вигаданих брендів, логотипів, написів, слоганів, літер, цифр, водяних знаків, рамок і помітних фірмових знаків на одязі чи тлі. Не наслідуй упізнавані брендовані дизайни. Одяг однотонний, без графічного принту.\n5. Для кожного файла вибери ОДИН тип одягу й ОДИН основний колір із наведених списків. Предмет і його колір повинні відповідати назві файла. Не створюй картинку одного типу з назвою іншого і не маскуй невдалу генерацію перейменуванням.\n6. Збалансовано варіюй типи й кольори, поки дозволяє кількість файлів. Не потрібно генерувати всі 32×24 комбінації. Створюй правдоподібний одяг; матеріал і крій мають відповідати предмету. Вони не є окремими токенами класифікації в назві. Не множ однакові байти лише різними назвами.\n\nТИПИ: tshirt, tank-top, polo-shirt, oxford-shirt, blouse, hoodie, sweatshirt, cardigan, sweater, turtleneck, crop-top, midi-dress, maxi-dress, wrap-dress, slip-dress, shirt-dress, jumpsuit, pleated-skirt, mini-skirt, chinos, cargo-pants, wide-leg-jeans, slim-jeans, joggers, shorts, leggings, bomber-jacket, denim-jacket, puffer-jacket, trench-coat, blazer, overshirt\n\nКОЛЬОРИ: black, white, ivory, navy, olive, sage, terracotta, burgundy, charcoal, sand, camel, dusty-rose, sky-blue, forest-green, mustard, lavender, cream, chocolate, stone-grey, coral, denim-blue, mint, rust, plum\n\nІМЕНА Й ФОРМАТ ФАЙЛІВ\n- Кожен предмет збережи окремим файлом: <garment>_<color>_<sequence>.<ext>.\n- garment і color — точні токени зі списків, нижній регістр. Між частинами — підкреслення; всередині складних токенів — дефіс. Без пробілів, кирилиці, додаткових типів/кольорів, брендів або рекламного тексту.\n- sequence — 001, 002, 003 тощо; не повторюй ім'я для різних файлів тієї самої пари. Для T-Shirt використовуй саме tshirt.\n- Приклади: hoodie_black_001.jpg; tshirt_white_001.png; tank-top_sage_002.jpg; wide-leg-jeans_denim-blue_001.jpg; midi-dress_dusty-rose_001.png; oxford-shirt_stone-grey_001.jpg.\n- Збережи як якісний JPEG або PNG. Якщо інструмент видає лише PNG, залиш PNG; не перейменовуй PNG на .jpg без справжнього перетворення. Файли мають бути статичними, кожен до 50 MB. Розмір 200 KB не є жорсткою вимогою: не псуй зображення, щоб досягти цього числа.\n\nПЕРЕВІРКА Й РЕЗУЛЬТАТ\n- Перевір кожен файл: окреме зображення 1:1, один цілий предмет, правильний тип і колір, біле тло, немає брендів/написів/людей, справжній підтримуваний формат і правильне ім'я. Якщо не відповідає — перегенеруй або чесно познач як незавершене, не включай у готовий набір.\n- Надай готові окремі файли в одній папці, а за можливості також архів для скачування. Архів потрібен лише для передачі мені: у Soty я перетягуватиму розпаковані картинки або виберу папку Google Drive. Додай короткий список: filename — тип — колір; не вписуй цей список у картинки.\n- Якщо тут немає інструмента генерації/збереження потрібної кількості файлів, скажи про обмеження й кількість реально готових. Не видавай список назв чи текстовий план за згенеровані зображення. Нічого самостійно не завантажуй у Soty, Google Drive або R2.";

/** Only a fixed version and action are collected, never clipboard or generated content. */
export function recordCatalogImagePrompt(
  action: 'requested' | 'succeeded' | 'failed' | 'manual_fallback',
  flowId: string
): void {
  try {
    analytics.track(
      action === 'requested'
        ? 'operation_started'
        : action === 'succeeded'
          ? 'operation_completed'
          : action === 'failed'
            ? 'operation_failed'
            : 'operation_stage_completed',
      {
        flow_id: flowId,
        feature_identifier: 'catalog_images',
        flow_step: 'catalog_image_prompt',
        action_identifier: action,
        ...(action === 'failed' ? { error_code: 'IMAGE_CLIPBOARD_UNAVAILABLE' } : {}),
        setting_name: 'catalog_image_prompt_version',
        setting_value: CATALOG_IMAGE_PROMPT_VERSION
      }
    );
  } catch {
    // Telemetry must not affect the clipboard action.
  }
}
