package ke.co.tealedger.supervisor

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Private Android shell for the existing Supervisor PWA. Navigation is limited
 * to the canonical production origin before the native sync bridge is exposed.
 */
class MainActivity : Activity() {
    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestNotificationPermissionIfNeeded()
        requestBatteryUnrestrictedGuidanceIfNeeded()
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView = WebView(this)
        configureWebView(webView)
        setContentView(
            webView,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        webView.loadUrl(CANONICAL_ORIGIN)
        PendingSyncScheduler.schedule(applicationContext, requestForegroundWatcher = false)
    }

    override fun onResume() {
        super.onResume()
        if (SecureSyncStore(applicationContext).hasPendingEvents()) {
            PendingSyncScheduler.schedule(applicationContext, requestForegroundWatcher = true)
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    private fun configureWebView(view: WebView) {
        view.setBackgroundColor(Color.rgb(250, 246, 234))
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            allowFileAccess = false
            allowContentAccess = false
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        view.addJavascriptInterface(NativeSyncBridge(applicationContext), BRIDGE_NAME)
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val target = request.url
                if (isCanonical(target)) return false
                openOutsideApp(target)
                return true
            }

            @Deprecated("Deprecated in Java")
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
                val target = Uri.parse(url)
                if (isCanonical(target)) return false
                openOutsideApp(target)
                return true
            }
        }
    }

    private fun isCanonical(uri: Uri): Boolean =
        uri.scheme == "https" && uri.host == CANONICAL_HOST && (uri.port == -1 || uri.port == 443)

    private fun openOutsideApp(uri: Uri) {
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_PERMISSION_REQUEST)
        }
    }

    private fun requestBatteryUnrestrictedGuidanceIfNeeded() {
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (power.isIgnoringBatteryOptimizations(packageName)) return
        val guidance = getSharedPreferences("tea_ledger_native_ui", Context.MODE_PRIVATE)
        if (guidance.getBoolean("battery_guidance_prompted", false)) return
        guidance.edit().putBoolean("battery_guidance_prompted", true).apply()
        AlertDialog.Builder(this)
            .setTitle("Keep completed work ready to sync")
            .setMessage(
                "Allow unrestricted battery for Tea Ledger Supervisor. This keeps the visible sync-pending service available when bundles return. Your records remain queued until the server accepts them.",
            )
            .setNegativeButton("Not now", null)
            .setPositiveButton("Allow") { _, _ ->
                runCatching {
                    startActivity(
                        Intent(
                            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                            Uri.parse("package:$packageName"),
                        ),
                    )
                }
            }
            .show()
    }

    private companion object {
        const val CANONICAL_ORIGIN = "https://tea-farm-ledger.vercel.app/"
        const val CANONICAL_HOST = "tea-farm-ledger.vercel.app"
        const val BRIDGE_NAME = "TeaLedgerAndroidSync"
        const val NOTIFICATION_PERMISSION_REQUEST = 701
    }
}
