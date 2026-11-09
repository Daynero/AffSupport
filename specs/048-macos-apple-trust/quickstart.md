# Quickstart: Apple trust для Soty на macOS

Перед будь-яким важким кроком: `uptime`, load менше 6, жодного іншого vitest, tsc чи пакування.

## Без сертифіката

Тест ланцюжка на фікстурі і на реальному статичному Node:

```zsh
NODE_TARBALL=/path/to/node-v22.23.4-darwin-arm64/bin/node
SOTY_TEST_NODE_BINARY="$NODE_TARBALL" npx vitest run tests/mac-signing-chain.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true
```

Очікування: верифікатор відхиляє сьогоднішній ad-hoc ланцюжок; ланцюжок підписує фікстуру без зауважень; реальний Node під hardened runtime виконує JS і WebAssembly; той самий Node без JIT-пари не стартує.

Підписати будь-який зібраний бандл ad-hoc:

```zsh
SOTY_SKIP_NOTARIZATION=1 zsh scripts/sign-mac-app.sh "release/beta/Soty Beta.app"   # Intel: release/beta/x64/
```

## З Developer ID

Один раз на релізній машині, нічого з цього не потрапляє в репозиторій:

```zsh
security find-identity -v -p codesigning            # має показати Developer ID Application: … (TEAMID)
xcrun notarytool store-credentials soty-notary      # Apple ID і app-specific пароль або ключ App Store Connect
```

Середовище релізу:

```zsh
export SOTY_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
export SOTY_NOTARY_KEYCHAIN_PROFILE=soty-notary
export MACOS_EXPECTED_TEAM_ID=<TEAMID>
unset SOTY_MACOS_TRUST_POLICY                       # типова developer-id
```

Підпис і нотаризація застосунку, потім DMG, потім гейт:

```zsh
npm run package:mac -- --arch=arm64                 # T010: сам викликає ланцюжок і пише release/signing.json
npm run package:dmg -- --arch=arm64                 # T011: підписує, нотаризує і степлить образ; хеш після staple
node scripts/verify-macos-release-trust.mjs release/Soty-v<version>-macOS-arm64.dmg --arch=arm64
# Intel: release/x64/Soty.app, release/x64/Soty-v<version>-macOS-x64.dmg, --arch=x64
```

Очікування гейта: `appleTrust: "verified"`, `notarized: true`, `stapled: true`, `hardenedMachO` більше нуля.

## Чистий Mac

Онлайн: завантажити опублікований DMG, перетягнути, запустити, дійти до авторизації без жодного попередження. Офлайн: вимкнути мережу до першого запуску свіжо встановленого застосунку; він має відкритися. Записати обидва результати в acceptance.
