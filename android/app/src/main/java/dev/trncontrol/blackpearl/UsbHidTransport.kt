package dev.trncontrol.blackpearl

import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.util.Log
import java.io.IOException

/**
 * The Android half of the DAC's byte pipe: implements the Go backend's
 * `USBTransport` over the USB Host API.
 *
 * Android gives unprivileged apps no hidraw access, so this stands in for
 * hidapi. It is the only Android-specific piece of the protocol stack --
 * packet framing, biquad maths, the response cache and the whole HTTP API
 * are the same Go code the desktop build runs.
 *
 * ## Why only the HID interface is claimed
 *
 * The Black Pearl is a composite device: USB Audio Class interfaces plus a
 * vendor HID interface for control. Claiming *only* the HID interface leaves
 * the audio interfaces to Android, so the phone keeps playing music through
 * the DAC while this app reconfigures it. Claiming the device wholesale would
 * cut the audio off, which would rather defeat the point.
 *
 * ## Report framing
 *
 * Packets are 64 bytes with the report ID (0x4B) at index 0, matching what
 * hidapi writes to hidraw and what the reference Python implementation sends
 * through pywinusb. Numbered HID reports carry the ID as the first byte on
 * the wire, so the buffer goes out verbatim. See android/README.md if the
 * device turns out not to use numbered reports.
 */
class UsbHidTransport private constructor(
    private val connection: UsbDeviceConnection,
    private val usbInterface: UsbInterface,
    private val endpointIn: UsbEndpoint,
    private val endpointOut: UsbEndpoint?,
) {

    @Volatile
    private var closed = false

    /** Reused across reads; only the read loop touches it. */
    private val readBuffer = ByteArray(REPORT_SIZE)

    /**
     * Sends one report. Failure here means the device is genuinely gone --
     * the Go layer reacts by tearing the connection down, so this must not
     * throw for anything recoverable.
     */
    @Throws(Exception::class)
    fun write(p: ByteArray) {
        if (closed) throw IOException("transport closed")

        val out = endpointOut
        val sent = if (out != null) {
            // bulkTransfer drives interrupt endpoints too, and unlike
            // UsbRequest it takes a timeout.
            connection.bulkTransfer(out, p, p.size, WRITE_TIMEOUT_MS)
        } else {
            // No interrupt OUT endpoint: fall back to the HID class's
            // SET_REPORT control request. wValue is (reportType << 8) |
            // reportId, with 0x02 meaning an Output report.
            val reportId = p[0].toInt() and 0xFF
            connection.controlTransfer(
                UsbConstants.USB_TYPE_CLASS or USB_RECIPIENT_INTERFACE, // 0x21
                HID_REQUEST_SET_REPORT,
                (HID_REPORT_TYPE_OUTPUT shl 8) or reportId,
                usbInterface.id,
                p,
                p.size,
                WRITE_TIMEOUT_MS,
            )
        }

        if (sent < 0) throw IOException("USB write failed (device detached?)")
    }

    /**
     * Reads the next report, or returns an EMPTY array if nothing arrived
     * within the timeout.
     *
     * The empty-array convention is the contract the Go side expects: a
     * timeout is the normal case for a polling read loop, and Java cannot
     * return a distinguished sentinel error across the gomobile boundary.
     * Throwing here would make the backend treat every idle poll as a
     * disconnect.
     */
    @Throws(Exception::class)
    fun read(timeoutMs: Long): ByteArray {
        if (closed) throw IOException("transport closed")

        val n = connection.bulkTransfer(endpointIn, readBuffer, readBuffer.size, timeoutMs.toInt())
        // bulkTransfer cannot distinguish "timed out" from "failed", so a
        // negative result is reported as a timeout. Real disconnects are
        // caught on the write path and, more reliably, by the DETACHED
        // broadcast -- neither depends on this guess.
        if (n <= 0) return EMPTY
        return readBuffer.copyOf(n)
    }

    /** Idempotent, and safe to call while a transfer is in flight. */
    @Throws(Exception::class)
    fun close() {
        if (closed) return
        closed = true
        try {
            connection.releaseInterface(usbInterface)
        } catch (e: Exception) {
            Log.w(TAG, "releaseInterface failed", e)
        }
        connection.close()
        Log.i(TAG, "USB transport closed")
    }

    companion object {
        private const val TAG = "TRNUsbHid"

        private const val REPORT_SIZE = 64
        private const val WRITE_TIMEOUT_MS = 500

        private const val USB_RECIPIENT_INTERFACE = 0x01
        private const val HID_REQUEST_SET_REPORT = 0x09
        private const val HID_REPORT_TYPE_OUTPUT = 0x02

        private val EMPTY = ByteArray(0)

        /**
         * Claims the DAC's HID interface and returns a ready transport.
         *
         * @throws IOException if the device has no HID interface, or the
         *   kernel HID driver will not release it.
         */
        @Throws(IOException::class)
        fun open(device: UsbDevice, connection: UsbDeviceConnection): UsbHidTransport {
            val hid = findHidInterface(device)
                ?: throw IOException("no HID interface on ${device.deviceName}")

            var epIn: UsbEndpoint? = null
            var epOut: UsbEndpoint? = null
            for (i in 0 until hid.endpointCount) {
                val ep = hid.getEndpoint(i)
                if (ep.type != UsbConstants.USB_ENDPOINT_XFER_INT) continue
                if (ep.direction == UsbConstants.USB_DIR_IN) {
                    if (epIn == null) epIn = ep
                } else {
                    if (epOut == null) epOut = ep
                }
            }
            val inEndpoint = epIn
                ?: throw IOException("HID interface has no interrupt IN endpoint")

            // force=true detaches the kernel HID driver, which has already
            // claimed this interface. Without it the claim fails on every
            // device that enumerated normally -- which is all of them.
            if (!connection.claimInterface(hid, true)) {
                connection.close()
                throw IOException("could not claim HID interface ${hid.id}")
            }

            Log.i(
                TAG,
                "claimed HID interface ${hid.id}: in=${inEndpoint.address}" +
                    (epOut?.let { ", out=${it.address}" } ?: ", out=none (using SET_REPORT)")
            )
            return UsbHidTransport(connection, hid, inEndpoint, epOut)
        }

        /** True if this is a Black Pearl we know how to talk to. */
        fun matches(device: UsbDevice): Boolean =
            device.vendorId == VENDOR_ID && device.productId == PRODUCT_ID

        /** Mirrors hidproto.VendorID / hidproto.ProductID. */
        const val VENDOR_ID = 0x3302
        const val PRODUCT_ID = 0x43E8

        private fun findHidInterface(device: UsbDevice): UsbInterface? {
            for (i in 0 until device.interfaceCount) {
                val intf = device.getInterface(i)
                if (intf.interfaceClass == UsbConstants.USB_CLASS_HID) return intf
            }
            return null
        }
    }
}
