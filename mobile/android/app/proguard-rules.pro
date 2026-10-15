# R8 (release minify) extra rules.
#
# error-prone annotations (pulled in transitively by the AMap Android SDK,
# issue 463) reference JDK annotation-processing classes that don't exist on
# Android; R8 fails the release build on the missing-class error. The debug
# APKs built by CI don't run R8, so this only bites signed release tag builds.
-dontwarn javax.lang.model.element.Modifier
