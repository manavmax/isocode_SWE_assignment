export type Lang = 'hi' | 'en';

/** One dictionary file (SPEC 15). Values use {param} slots filled by t();
 * never concatenated fragments. Hindi uses polite "aap" throughout. */
const en = {
  appName: 'Field Collections',
  navToday: 'Today',
  navMe: 'Me',
  loginTitle: 'Sign in',
  loginUsername: 'Username',
  loginPin: 'PIN (digits only)',
  loginSubmit: 'Sign in',
  loginDemoAccounts: 'Demo accounts',
  loginInvalid: 'Wrong username or PIN',
  loginNetwork: "Couldn't reach server. Check your connection and try again.",
  loginThrottled: 'Too many attempts. Try again in a few minutes.',
  loginLanguageLabel: 'Choose language',
  todayTitle: "Today's visits",
  todayVisits: '{n} visits assigned',
  todayVisitsOne: '1 visit assigned',
  todayLastUpdated: 'Last updated {time}',
  todayEmptyTitle: 'All caught up, no visits assigned today',
  todayEmptyAction: 'Refresh list',
  cardOverdue: 'Overdue',
  bucketNotOverdue: 'Not overdue',
  bucket1to30: '1-30 days',
  bucket31to60: '31-60 days',
  bucket61to90: '61-90 days',
  bucket90plus: 'Over 90 days',
  detailTitle: 'Loan details',
  factLoanId: 'Loan ID',
  factBorrower: 'Borrower',
  factBusiness: 'Business',
  factOutstanding: 'Outstanding',
  factOverdue: 'Overdue',
  factEmi: 'EMI',
  factDpd: 'Days past due',
  factBucket: 'Bucket',
  factProduct: 'Product',
  factAddress: 'Address',
  factPincode: 'Pincode',
  factLocality: 'Locality',
  factPhone: 'Phone (masked)',
  factAltPhone: 'Alt phone (masked)',
  factStatus: 'Status',
  statusOverdue: 'Overdue',
  statusCleared: 'Cleared',
  statusQueue: 'Queued',
  mapButton: 'Open in Maps',
  meTitle: 'Me',
  meAccount: 'Account',
  meLanguage: 'Language',
  meLogout: 'Log out',
  meOfflineCache: 'Assignment list cached on this phone; expires after 24 hours.',
  offlineBanner: "You're offline. Showing saved data.",
  stateLoading: 'Loading…',
  stateErrorTitle: "Couldn't reach server",
  stateErrorBody: 'Check your connection and try again.',
  stateRetry: 'Retry',
  stateEmptyTitle: 'Nothing here yet',
  stateEmptyBody: 'Data will appear after the daily import.',
  notFoundTitle: 'Not found',
  notFoundBody: 'This loan is not in your assignments.',
  back: 'Back',
  demoBadge: '(demo)'
};

export type Dict = typeof en;

/** Hindi copy: polite register ("aap"), spoken-finance phrasing.
 * NOTE: native review pending (docs/assumptions.md A49). */
const hi: Dict = {
  appName: 'फील्ड कलेक्शन',
  navToday: 'आज',
  navMe: 'मेरी जानकारी',
  loginTitle: 'साइन इन करें',
  loginUsername: 'यूज़रनेम',
  loginPin: 'पिन (केवल अंक)',
  loginSubmit: 'साइन इन करें',
  loginDemoAccounts: 'डेमो खाते',
  loginInvalid: 'यूज़रनेम या पिन गलत है',
  loginNetwork: 'सर्वर से संपर्क नहीं हो पाया। कनेक्शन जाँचकर फिर कोशिश करें।',
  loginThrottled: 'बहुत अधिक कोशिशें हो गईं। कुछ मिनट बाद फिर कोशिश करें।',
  loginLanguageLabel: 'भाषा चुनें',
  todayTitle: 'आज की विज़िट',
  todayVisits: '{n} विज़िट सौंपी गई हैं',
  todayVisitsOne: '1 विज़िट सौंपी गई है',
  todayLastUpdated: 'आख़िरी अपडेट {time}',
  todayEmptyTitle: 'सब पूरा हो गया, आज कोई विज़िट नहीं है',
  todayEmptyAction: 'सूची रिफ़्रेश करें',
  cardOverdue: 'बाकी भुगतान',
  bucketNotOverdue: 'बकाया नहीं',
  bucket1to30: '1-30 दिन',
  bucket31to60: '31-60 दिन',
  bucket61to90: '61-90 दिन',
  bucket90plus: '90 दिनों से अधिक',
  detailTitle: 'लोन विवरण',
  factLoanId: 'लोन नंबर',
  factBorrower: 'उधारकर्ता',
  factBusiness: 'व्यवसाय',
  factOutstanding: 'कुल बाकी',
  factOverdue: 'बाकी भुगतान',
  factEmi: 'किश्त (EMI)',
  factDpd: 'अतीत दिन (DPD)',
  factBucket: 'श्रेणी',
  factProduct: 'उत्पाद',
  factAddress: 'पता',
  factPincode: 'पिनकोड',
  factLocality: 'इलाक़ा',
  factPhone: 'फ़ोन (छिपा हुआ)',
  factAltPhone: 'दूसरा फ़ोन (छिपा हुआ)',
  factStatus: 'स्थिति',
  statusOverdue: 'बकाया',
  statusCleared: 'चुका दिया',
  statusQueue: 'क़तार में',
  mapButton: 'नक्शे में खोलें',
  meTitle: 'मेरी जानकारी',
  meAccount: 'खाता',
  meLanguage: 'भाषा',
  meLogout: 'लॉग आउट',
  meOfflineCache: 'असाइनमेंट सूची इस फ़ोन पर सहेजी गई है; 24 घंटे बाद समाप्त हो जाएगी।',
  offlineBanner: 'आप ऑफ़लाइन हैं। सहेजा गया डेटा दिख रहा है।',
  stateLoading: 'लोड हो रहा है…',
  stateErrorTitle: 'सर्वर से संपर्क नहीं हो पाया',
  stateErrorBody: 'कनेक्शन जाँचकर फिर कोशिश करें।',
  stateRetry: 'फिर कोशिश करें',
  stateEmptyTitle: 'अभी कुछ नहीं है',
  stateEmptyBody: 'रोज़ की अपलोड के बाद डेटा यहाँ दिखेगा।',
  notFoundTitle: 'नहीं मिला',
  notFoundBody: 'यह लोन आपकी सूची में नहीं है।',
  back: 'वापस',
  demoBadge: '(डेमो)'
};

export const dictionaries: Record<Lang, Dict> = { en, hi };

export type DictKey = keyof Dict;

export function t(lang: Lang, key: DictKey, params?: Record<string, string | number>): string {
  let text: string = dictionaries[lang][key];
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

export function isLang(value: unknown): value is Lang {
  return value === 'hi' || value === 'en';
}
