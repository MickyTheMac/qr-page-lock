# Cross-checks PageLock signatures with pyHanko, an independent, maintained PAdES validator.
# pip install pyhanko==0.29.1 ; python3 scripts/interop/validate_pyhanko.py fixtures/16-signed-by-both.pdf <root.pem>
# (The root certificate PEM is the first entry of signerAuthorities in the trust file.)
import sys
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko.keys import load_cert_from_pemder
from pyhanko_certvalidator import ValidationContext
root = load_cert_from_pemder(sys.argv[2])
with open(sys.argv[1], 'rb') as f:
    r = PdfFileReader(f)
    for s in r.embedded_signatures:
        vc = ValidationContext(trust_roots=[root], allow_fetching=False, revocation_mode='soft-fail')
        st = validate_pdf_signature(s, signer_validation_context=vc, ts_validation_context=vc)
        print(s.field_name, 'intact', st.intact, 'valid', st.valid, 'trusted', st.trusted, 'coverage', st.coverage, 'modification', st.modification_level, 'ts', st.timestamp_validity and st.timestamp_validity.valid, st.timestamp_validity and st.timestamp_validity.trusted)
        print('  ', st.summary())
