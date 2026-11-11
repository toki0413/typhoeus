# Commons Android APK 构建指南

## 快速开始（在有 Android Studio / SDK 的机器上）

```bash
# 1. 克隆项目（或者直接把整个 /workspace/commons 目录拷贝过去）

# 2. 安装依赖
cd commons
npm install

# 3. 确保 www/ 目录里有最新的 commons.html
cp commons.html www/index.html

# 4. 同步到 Android 项目
npx cap sync android

# 5a. 用 Android Studio 打开（最简单）
npx cap open android
# 然后 Android Studio → Build → Build Bundle(s) / APK(s) → Build APK(s)
# APK 会出现在 android/app/build/outputs/apk/debug/app-debug.apk

# 5b. 或者命令行（需要 Android SDK 设置好 ANDROID_HOME）
export ANDROID_HOME=$HOME/Android/Sdk   # 或你的 SDK 路径
cd android
./gradlew assembleDebug
# APK 在 app/build/outputs/apk/debug/app-debug.apk
```

## 生产发布（签名 APK）

```bash
# 1. 生成签名密钥
keytool -genkey -v -keystore commons-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias commons

# 2. 在 android/app/build.gradle 里添加 signing config（见官方文档）

# 3. 构建 release APK
cd android
./gradlew assembleRelease
# APK 在 app/build/outputs/apk/release/app-release.apk
```

## iOS（需要 macOS + Xcode）

```bash
# 1. 在 Mac 上安装依赖
cd commons
npm install @capacitor/ios @capacitor/core @capacitor/cli

# 2. 添加 iOS 平台
npx cap add ios

# 3. 同步
cp commons.html www/index.html
npx cap sync ios

# 4. 用 Xcode 打开
npx cap open ios
# Xcode 里选 "Any iOS Device" → Product → Archive → 导出 IPA
```

## 项目结构

```
commons/
├── commons.html              ← 主文件（单文件 PWA，270KB）
├── www/                      ← Capacitor Web 资源目录
│   ├── index.html            ← commons.html 的副本
│   ├── manifest.webmanifest
│   ├── sw.js
│   └── icons/
├── capacitor.config.json     ← Capacitor 配置
├── src/*.js                  ← 源码（18 个文件）
├── android/                  ← Android 原生项目
│   ├── gradlew               ← Gradle wrapper（可执行）
│   ├── app/build.gradle
│   └── app/src/main/assets/  ← sync 后的 Web 资源在这里
└── package.json
```

## 更新 App 内容后

每次你改了 commons.html：
```bash
cp commons.html www/index.html
npx cap sync android
# 然后重新 Build APK
```
