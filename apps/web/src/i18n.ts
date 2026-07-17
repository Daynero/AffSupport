import { useEffect, useState } from 'react';

export type Language = 'en' | 'uk';
const en = {
  privateLocalSimple:'PRIVATE · LOCAL · SIMPLE', title:'Local Video Compressor', subtitle:'Smaller videos, without leaving your Mac.',
  connectingAgent:'Connecting to the Mac Agent…', lookingForAgent:'Looking for the Mac Agent…', keepAgentOpen:'Please keep the Agent open. This may take a few seconds.',
  agentConnected:'Agent connected', agentDisconnected:'Agent disconnected', agentNotRunning:'Mac Agent is not running', agentUpdateRequired:'Agent update required', connectionBlocked:'Connection blocked',
  restoreQueue:'Open the Mac Agent to restore your current queue.', reconnect:'Reconnect', copyDiagnostics:'Copy diagnostics', diagnosticsCopied:'Safe diagnostics copied.',
  updateTitle:'Your Mac Agent needs an update.', updateBody:'Install the latest Apple Silicon test version to continue.', downloadLatest:'Download latest version',
  blockedTitle:'Your browser blocked access to the Mac Agent.', blockedBody:'Allow Local Network access and try again.', tryAgain:'Try again', openLocal:'Open local version',
  onboardingTitle:'Compress videos privately on your Mac', onboardingBody:'Install the free Mac Agent to process videos locally.', neverUploaded:'Your files are never uploaded.', appleSilicon:'For Apple Silicon Macs',
  downloadAgent:'Download Agent for Mac', connectAgent:'I’ve opened the Agent — Connect', installationHelp:'Installation help',
  install1:'Download the DMG.', install2:'Open it.', install3:'Drag Local Video Compressor Agent to Applications.', install4:'Open the app from Applications.', install5:'Return to this page.', install6:'If macOS blocks the app, Control-click it in Applications, choose Open, then confirm Open.', notNotarized:'This warning appears because the test version is not yet notarized by Apple.',
  compression:'Compression', quality:'Quality', qualityNote:'Original dimensions with the best visual quality.', balanced:'Balanced', balancedNote:'Great everyday size and quality, up to 720p.', ultraSmall:'Ultra Small', ultraSmallNote:'Smallest shareable files, up to 550p.',
  saveResults:'Save results', nextToOriginals:'Next to originals', chooseFolder:'Choose output folder', chooseAFolder:'Choose a folder', besideSource:'Each result stays beside its source.',
  selectVideos:'Select videos', startCompression:'Start compression', filesStay:'🔒 Files stay on this Mac', engineUnavailable:'The bundled video engine is unavailable. Reinstall the Mac Agent.',
  filesCompleted:'files completed', overallProgress:'Overall progress', clearFinished:'Clear finished', queueEmpty:'Your queue is empty', queueEmptyBody:'Select one or more videos to begin.',
  completed:'Completed', errors:'Errors', original:'Original', result:'Result', spaceSaved:'Space saved', showOutput:'Show output folder',
  cancel:'Cancel', remove:'Remove', retry:'Retry', showFinder:'Show in Finder', working:'Working…', saved:'saved', estimating:'Estimating size…', estimated:'Estimated', smaller:'smaller', mayBeLarger:'may be larger', estimateUnavailable:'Estimate unavailable', estimatePaused:'Estimate paused', waitingEstimate:'Waiting for estimate',
  statusQueued:'queued', statusProcessing:'processing', statusCompleted:'completed', statusFailed:'failed', statusCancelled:'cancelled', statusInterrupted:'interrupted',
  addAnyway:'Add anyway?', duplicate:'This video is already in the queue.', alreadyCompressed:'This video appears to be already compressed.', genericError:'Something went wrong.', pairingRequired:'Open the Mac Agent to connect securely.', connectionFailed:'Could not reach the Mac Agent.', timeout:'The Mac Agent did not respond in time.', invalidToken:'The secure connection expired. Open the Mac Agent again.', sourceUnavailable:'The source file is no longer available.', fileProcessFailed:'The file could not be processed.', compressionCancelled:'Compression was cancelled.', compressionFailed:'The video could not be compressed.', diskWarning:'Available disk space may be insufficient. Compression can continue, but consider freeing some space.', diskCheckFailed:'Available disk space could not be checked.',
  language:'Language', english:'English', ukrainian:'Українська'
} as const;

const uk: Record<keyof typeof en, string> = {
  privateLocalSimple:'ПРИВАТНО · ЛОКАЛЬНО · ПРОСТО', title:'Локальний відеокомпресор', subtitle:'Менші відео, які не залишають ваш Mac.',
  connectingAgent:'Підключення до Mac Agent…', lookingForAgent:'Шукаємо Mac Agent…', keepAgentOpen:'Залиште Agent відкритим. Це може зайняти кілька секунд.',
  agentConnected:'Agent підключено', agentDisconnected:'Agent від’єднано', agentNotRunning:'Mac Agent не запущено', agentUpdateRequired:'Потрібне оновлення Agent', connectionBlocked:'Підключення заблоковано',
  restoreQueue:'Відкрийте Mac Agent, щоб відновити поточну чергу.', reconnect:'Підключитися знову', copyDiagnostics:'Копіювати діагностику', diagnosticsCopied:'Безпечну діагностику скопійовано.',
  updateTitle:'Ваш Mac Agent потрібно оновити.', updateBody:'Встановіть останню тестову версію для Apple Silicon.', downloadLatest:'Завантажити останню версію',
  blockedTitle:'Браузер заблокував доступ до Mac Agent.', blockedBody:'Дозвольте доступ до локальної мережі та повторіть спробу.', tryAgain:'Спробувати знову', openLocal:'Відкрити локальну версію',
  onboardingTitle:'Стискайте відео приватно на своєму Mac', onboardingBody:'Встановіть безкоштовний Mac Agent для локальної обробки відео.', neverUploaded:'Ваші файли нікуди не завантажуються.', appleSilicon:'Для Mac з Apple Silicon',
  downloadAgent:'Завантажити Agent для Mac', connectAgent:'Я відкрив Agent — Підключити', installationHelp:'Допомога зі встановленням',
  install1:'Завантажте DMG.', install2:'Відкрийте його.', install3:'Перетягніть Local Video Compressor Agent до Applications.', install4:'Відкрийте застосунок із папки Applications.', install5:'Поверніться на цю сторінку.', install6:'Якщо macOS блокує застосунок, натисніть його з Control у папці Applications, виберіть Open і підтвердьте Open.', notNotarized:'Це попередження з’являється, бо тестову версію ще не нотаризовано Apple.',
  compression:'Стиснення', quality:'Якість', qualityNote:'Оригінальні розміри з найкращою якістю зображення.', balanced:'Збалансований', balancedNote:'Оптимальний розмір і якість для щоденного використання, до 720p.', ultraSmall:'Найменший', ultraSmallNote:'Найменші файли для надсилання, до 550p.',
  saveResults:'Збереження результатів', nextToOriginals:'Поруч з оригіналами', chooseFolder:'Вибрати папку', chooseAFolder:'Виберіть папку', besideSource:'Кожен результат зберігається поруч з оригіналом.',
  selectVideos:'Вибрати відео', startCompression:'Почати стиснення', filesStay:'🔒 Файли залишаються на цьому Mac', engineUnavailable:'Вбудований відеомодуль недоступний. Перевстановіть Mac Agent.',
  filesCompleted:'файлів завершено', overallProgress:'Загальний прогрес', clearFinished:'Очистити завершені', queueEmpty:'Черга порожня', queueEmptyBody:'Виберіть одне або кілька відео, щоб почати.',
  completed:'Завершено', errors:'Помилки', original:'Оригінал', result:'Результат', spaceSaved:'Заощаджено', showOutput:'Показати папку результатів',
  cancel:'Скасувати', remove:'Видалити', retry:'Повторити', showFinder:'Показати у Finder', working:'Обробка…', saved:'заощаджено', estimating:'Оцінювання розміру…', estimated:'Орієнтовно', smaller:'менше', mayBeLarger:'може бути більшим', estimateUnavailable:'Оцінка недоступна', estimatePaused:'Оцінювання призупинено', waitingEstimate:'Очікування оцінки',
  statusQueued:'у черзі', statusProcessing:'обробка', statusCompleted:'завершено', statusFailed:'помилка', statusCancelled:'скасовано', statusInterrupted:'перервано',
  addAnyway:'Усе одно додати?', duplicate:'Це відео вже є в черзі.', alreadyCompressed:'Схоже, це відео вже стиснене.', genericError:'Щось пішло не так.', pairingRequired:'Відкрийте Mac Agent для безпечного підключення.', connectionFailed:'Не вдалося підключитися до Mac Agent.', timeout:'Mac Agent не відповів вчасно.', invalidToken:'Безпечне з’єднання завершилося. Відкрийте Mac Agent знову.', sourceUnavailable:'Оригінальний файл більше недоступний.', fileProcessFailed:'Не вдалося обробити файл.', compressionCancelled:'Стиснення скасовано.', compressionFailed:'Не вдалося стиснути відео.', diskWarning:'Вільного місця може бути недостатньо. Стиснення можна продовжити, але варто звільнити місце.', diskCheckFailed:'Не вдалося перевірити вільне місце.',
  language:'Мова', english:'English', ukrainian:'Українська'
};

export type TranslationKey = keyof typeof en;
const dictionaries = { en, uk };
export function detectLanguage(saved: string | null, browserLanguages: readonly string[]): Language { if (saved === 'en' || saved === 'uk') return saved; return browserLanguages.some(value => value.toLowerCase().startsWith('uk')) ? 'uk' : 'en'; }
export function translate(language: Language, key: TranslationKey) { return dictionaries[language][key]; }
export function useI18n() {
  const [language, update] = useState<Language>(() => detectLanguage(localStorage.getItem('language'), navigator.languages?.length ? navigator.languages : [navigator.language]));
  useEffect(() => { localStorage.setItem('language', language); document.documentElement.lang = language; }, [language]);
  return { language, setLanguage: update, t: (key: TranslationKey) => translate(language, key) };
}
