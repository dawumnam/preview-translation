import kr.dogfoot.hwp2hwpx.Hwp2Hwpx;
import kr.dogfoot.hwplib.object.HWPFile;
import kr.dogfoot.hwplib.reader.HWPReader;
import kr.dogfoot.hwpxlib.object.HWPXFile;
import kr.dogfoot.hwpxlib.writer.HWPXWriter;

public class Hwp2HwpxCli {
    public static void main(String[] args) throws Exception {
        if (args.length != 2) {
            System.err.println("usage: Hwp2HwpxCli <input.hwp> <output.hwpx>");
            System.exit(1);
        }
        HWPFile fromFile = HWPReader.fromFile(args[0]);
        HWPXFile toFile = Hwp2Hwpx.toHWPX(fromFile);
        HWPXWriter.toFilepath(toFile, args[1]);
        System.out.println("wrote " + args[1]);
    }
}
